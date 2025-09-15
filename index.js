// --- IMPORTS ---
import express from "express";
import Redis from "ioredis";
import axios from "axios";
import dotenv from "dotenv";
import querystring from "querystring";
import { PrismaClient } from "@prisma/client";
import { randomUUID } from "crypto";
import opencage from "opencage-api-client";

// --- CONFIGURATION ---
dotenv.config();
const app = express();
const port = process.env.PORT || 3000;
const prisma = new PrismaClient();
app.use(express.json());

// --- REDIS CLIENT SETUP (using ioredis) ---
const redis = new Redis(process.env.REDIS_URL);
redis.on("error", (err) => console.error("Redis Client Error", err));
redis.on("connect", () => console.log("🚀 Successfully connected to Redis."));

// --- HELPER FUNCTIONS ---
const getUserCoordinates = async (location) => {
  const sanitizedLocation = location.toLowerCase().replace(/[^a-z0-9]/g, "");
  const cacheKey = `coords:${sanitizedLocation}`;

  const cachedCoords = await redis.get(cacheKey);
  if (cachedCoords) {
    console.log(`Cache HIT for coordinates: ${location}`);
    return JSON.parse(cachedCoords);
  }

  console.log(`Cache MISS for coordinates: ${location}. Calling OpenCage API.`);
  const geoData = await opencage.geocode({
    q: location,
    key: process.env.OPENCAGE_API_KEY,
  });
  if (!geoData.results || geoData.results.length === 0) {
    throw new Error(`Could not determine coordinates for ${location}`);
  }

  const { lat, lng } = geoData.results[0].geometry;
  const coords = { lat, lon: lng };

  await redis.set(cacheKey, JSON.stringify(coords), "EX", 60 * 60 * 24 * 30);
  return coords;
};

// --- PETFINDER TOKEN MANAGEMENT ---
let petfinderToken = { token: null, expiresAt: 0 };

const fetchPetfinderToken = async () => {
  try {
    console.log("Fetching new Petfinder token...");
    const response = await axios.post(
      "https://api.petfinder.com/v2/oauth2/token",
      querystring.stringify({
        grant_type: "client_credentials",
        client_id: process.env.PETFINDER_CLIENT_ID,
        client_secret: process.env.PETFINDER_CLIENT_SECRET,
      })
    );
    const { access_token, expires_in } = response.data;
    petfinderToken = {
      token: access_token,
      expiresAt: Date.now() + (expires_in - 60) * 1000,
    };
    return petfinderToken.token;
  } catch (error) {
    console.error(
      "Error fetching Petfinder token:",
      error.response?.data || error.message
    );
    throw new Error("Could not fetch token from Petfinder");
  }
};

const addPetfinderToken = async (req, res, next) => {
  if (!petfinderToken.token || Date.now() >= petfinderToken.expiresAt) {
    try {
      await fetchPetfinderToken();
    } catch (error) {
      return res
        .status(500)
        .json({ message: "Could not authenticate with Petfinder API" });
    }
  }
  req.petfinderToken = petfinderToken.token;
  next();
};

// --- ROUTES ---
app.get("/", (req, res) => res.send("Pawadopt Server is running!"));

app.get("/api/animals", addPetfinderToken, async (req, res) => {
  const cacheKey = `animals:${querystring.stringify(req.query)}`;
  try {
    const cachedData = await redis.get(cacheKey);
    if (cachedData) {
      res.setHeader("X-Cache", "HIT");
      return res.json(JSON.parse(cachedData));
    }
    res.setHeader("X-Cache", "MISS");
    const petfinderResponse = await axios.get(
      "https://api.petfinder.com/v2/animals",
      {
        headers: { Authorization: `Bearer ${req.petfinderToken}` },
        params: req.query,
      }
    );
    await redis.set(
      cacheKey,
      JSON.stringify(petfinderResponse.data),
      "EX",
      3600
    );
    res.json(petfinderResponse.data);
  } catch (error) {
    console.error(
      "Error in /api/animals:",
      error.response?.data || error.message
    );
    res
      .status(500)
      .json({ message: "An error occurred while fetching animals." });
  }
});

app.post("/api/videos", async (req, res) => {
  const { location, page = 1, sessionId } = req.body;
  const PAGE_SIZE = 10;

  if (!location) {
    return res.status(400).json({ message: "Location is required." });
  }

  try {
    // PATH 1: User has a session, fetch the next page from their "playlist"
    if (sessionId) {
      const sessionKey = `session:${sessionId}`;
      const animalIdsJson = await redis.get(sessionKey);

      if (!animalIdsJson) {
        return res
          .status(404)
          .json({ message: "Session expired. Please refresh." });
      }

      const animalIds = JSON.parse(animalIdsJson);
      const totalPages = Math.ceil(animalIds.length / PAGE_SIZE);
      const pageIds = animalIds.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

      if (pageIds.length === 0) {
        return res.json({
          animals: [],
          pagination: { currentPage: page, totalPages, sessionId },
        });
      }

      const animalsData = await prisma.animalWithVideo.findMany({
        where: { id: { in: pageIds } },
      });
      const orderedAnimals = pageIds
        .map((id) => animalsData.find((a) => a.id === id))
        .filter(Boolean);

      return res.json({
        animals: orderedAnimals,
        pagination: { currentPage: page, totalPages, sessionId },
      });
    }

    // PATH 2: No session, create one with the egress-optimized query
    console.log(`Creating new session for location: ${location}`);
    const coords = await getUserCoordinates(location);
    const userLat = coords.lat;
    const userLon = coords.lon;
    const searchRadiusMiles = 150;

    const candidateIdsResult = await prisma.$queryRaw`
      SELECT id FROM "AnimalWithVideo"
      WHERE latitude IS NOT NULL AND longitude IS NOT NULL AND
        (6371 * acos(cos(radians(${userLat})) * cos(radians(latitude)) * cos(radians(longitude) - radians(${userLon})) + sin(radians(${userLat})) * sin(radians(latitude)))) < ${
      searchRadiusMiles * 1.60934
    }
      LIMIT 200;
    `;

    let candidateIds = candidateIdsResult.map((c) => c.id);

    if (candidateIds.length < 50) {
      const randomNationwide = await prisma.animalWithVideo.findMany({
        take: 50,
        select: { id: true },
      });
      const existingIds = new Set(candidateIds);
      for (const animal of randomNationwide) {
        if (!existingIds.has(animal.id)) candidateIds.push(animal.id);
      }
    }

    for (let i = candidateIds.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [candidateIds[i], candidateIds[j]] = [candidateIds[j], candidateIds[i]];
    }

    const newSessionId = randomUUID();
    await redis.set(
      `session:${newSessionId}`,
      JSON.stringify(candidateIds),
      "EX",
      7200
    );

    const totalPages = Math.ceil(candidateIds.length / PAGE_SIZE);
    const pageIds = candidateIds.slice(0, PAGE_SIZE);

    if (pageIds.length === 0) {
      return res.json({
        animals: [],
        pagination: { currentPage: 1, totalPages, sessionId: newSessionId },
      });
    }

    const pageData = await prisma.animalWithVideo.findMany({
      where: { id: { in: pageIds } },
    });
    const orderedAnimals = pageIds
      .map((id) => pageData.find((a) => a.id === id))
      .filter(Boolean);

    res.json({
      animals: orderedAnimals,
      pagination: { currentPage: 1, totalPages, sessionId: newSessionId },
    });
  } catch (error) {
    console.error("Error in /api/videos:", error);
    res.status(500).json({ message: "Failed to fetch video feed." });
  }
});

app.get("/api/animal/:id", async (req, res) => {
  const { id } = req.params;
  const animalId = parseInt(id);
  if (isNaN(animalId)) {
    return res.status(400).json({ message: "Invalid animal ID." });
  }
  const cacheKey = `animal:${animalId}`;

  try {
    const cachedAnimal = await redis.get(cacheKey);
    if (cachedAnimal) {
      res.setHeader("X-Cache", "HIT");
      return res.json(JSON.parse(cachedAnimal));
    }

    res.setHeader("X-Cache", "MISS");
    const animal = await prisma.animalWithVideo.findUnique({
      where: { id: animalId },
    });
    if (!animal) {
      return res
        .status(404)
        .json({ message: "Animal not found in our video database." });
    }

    await redis.set(cacheKey, JSON.stringify(animal), "EX", 21600);
    res.json(animal);
  } catch (error) {
    console.error(`Error fetching animal ${id}:`, error);
    res.status(500).json({ message: "An error occurred." });
  }
});

app.post("/api/animal/:id/like", async (req, res) => {
  const { id } = req.params;
  const { action } = req.body; // Expect 'like' or 'unlike'
  const animalId = parseInt(id);

  if (isNaN(animalId) || !["like", "unlike"].includes(action)) {
    return res.status(400).json({ message: "Invalid request." });
  }

  try {
    const updatedAnimal = await prisma.animalWithVideo.update({
      where: { id: animalId },
      data: {
        // Conditionally create the correct object with only one key
        likeCount: action === "like" ? { increment: 1 } : { decrement: 1 },
      },
      select: { likeCount: true },
    });

    res.json({ newLikeCount: updatedAnimal.likeCount });
  } catch (error) {
    console.error(`Error updating like count for animal ${id}:`, error);
    res.status(500).json({ message: "Could not update like count." });
  }
});

// --- SERVER START ---
app.listen(port, () => {
  console.log(`✅ Server listening on http://localhost:${port}`);
});
