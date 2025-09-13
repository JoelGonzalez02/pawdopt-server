// --- IMPORTS ---
import express from "express";
import Redis from "ioredis";
import axios from "axios";
import dotenv from "dotenv";
import querystring from "querystring";
import { PrismaClient } from "@prisma/client";
import { randomUUID } from "crypto"; // For generating unique session IDs

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
      }),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
    );
    const { access_token, expires_in } = response.data;
    petfinderToken = {
      token: access_token,
      expiresAt: Date.now() + (expires_in - 60) * 1000,
    };
    console.log("Successfully fetched new token.");
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

/**
 * Main endpoint for the discovery/swipe card screen with caching.
 */
app.get("/api/animals", addPetfinderToken, async (req, res) => {
  const cacheKey = `animals:${querystring.stringify(req.query)}`;
  try {
    const cachedData = await redis.get(cacheKey);
    if (cachedData) {
      console.log(`Cache HIT for discovery: ${cacheKey}`);
      res.setHeader("X-Cache", "HIT");
      return res.json(JSON.parse(cachedData));
    }

    console.log(`Cache MISS for discovery: ${cacheKey}`);
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

/**
 * The intelligent video reels endpoint using a stateful session model.
 */
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
      const totalItems = animalIds.length;
      const totalPages = Math.ceil(totalItems / PAGE_SIZE);
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
        .map((id) => animalsData.find((a) => a.id === id)?.rawJson)
        .filter(Boolean);

      return res.json({
        animals: orderedAnimals,
        pagination: { currentPage: page, totalPages, sessionId },
      });
    }

    // PATH 2: No session, create a new one (for Page 1)
    // PATH 2: No session, create a new one (for Page 1)
    const [city, state] = location.split(",").map((s) => s.trim());
    let candidates = await prisma.animalWithVideo.findMany({
      where: { state: state }, // <--- Query by state for a broader, more relevant pool
      take: 500, // Take a larger pool since we are searching the whole state
    });

    if (candidates.length < 50) {
      const randomNationwide = await prisma.animalWithVideo.findMany({
        take: 50,
      });
      const existingIds = new Set(candidates.map((c) => c.id));
      for (const animal of randomNationwide) {
        if (!existingIds.has(animal.id)) candidates.push(animal);
      }
    }

    // Shuffle the candidates
    for (let i = candidates.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
    }

    const newSessionId = randomUUID();
    const animalIds = candidates.map((c) => c.id);

    // Store the full "playlist" of IDs in Redis for 2 hours
    await redis.set(
      `session:${newSessionId}`,
      JSON.stringify(animalIds),
      "EX",
      7200
    );

    const totalPages = Math.ceil(animalIds.length / PAGE_SIZE);
    const pageData = candidates
      .slice(0, PAGE_SIZE)
      .map((animal) => animal.rawJson);

    res.json({
      animals: pageData,
      pagination: { currentPage: 1, totalPages, sessionId: newSessionId },
    });
  } catch (error) {
    console.error("Error in /api/videos:", error);
    res.status(500).json({ message: "Failed to fetch video feed." });
  }
});

/**
 * Endpoint to get details for a single animal.
 */
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
      console.log(`Cache HIT for animal: ${animalId}`);
      res.setHeader("X-Cache", "HIT");
      return res.json(JSON.parse(cachedAnimal));
    }

    console.log(`Cache MISS for animal: ${animalId}`);
    res.setHeader("X-Cache", "MISS");

    const animal = await prisma.animalWithVideo.findUnique({
      where: { id: animalId },
    });
    const finalData = animal ? animal.rawJson : null;

    if (!finalData) {
      return res
        .status(404)
        .json({ message: "Animal not found in our video database." });
    }

    await redis.set(cacheKey, JSON.stringify(finalData), "EX", 21600);
    res.json(finalData);
  } catch (error) {
    console.error(`Error fetching animal ${id}:`, error);
    res.status(500).json({ message: "An error occurred." });
  }
});

// --- SERVER START ---
app.listen(port, () => {
  console.log(`✅ Server listening on http://localhost:${port}`);
});
