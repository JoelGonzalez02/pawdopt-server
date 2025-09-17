// --- IMPORTS ---
import express from "express";
import Redis from "ioredis";
import axios from "axios";
import dotenv from "dotenv";
import querystring from "querystring";
import { PrismaClient } from "@prisma/client";
import { randomUUID } from "crypto";
import opencage from "opencage-api-client";
import rateLimit from "express-rate-limit"; // Security
import pino from "pino"; // Logging

// --- CONFIGURATION & INITIALIZATION ---
dotenv.config();
const app = express();
const port = process.env.PORT || 3000;
const prisma = new PrismaClient();

// --- LOGGER & SECURITY MIDDLEWARE ---
const logger = pino({
  transport:
    process.env.NODE_ENV !== "production"
      ? { target: "pino-pretty" }
      : undefined,
});

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 200, // Limit each IP to 200 requests per 15 mins
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many requests, please try again later." },
});

app.use(express.json());
app.use(limiter); // Apply rate limiting to all API routes

// --- REDIS CLIENT SETUP ---
const redis = new Redis(process.env.REDIS_URL);
redis.on("error", (err) => logger.error({ err }, "Redis Client Error"));
redis.on("connect", () => logger.info("🚀 Successfully connected to Redis."));

// --- HELPER FUNCTIONS ---
const getUserCoordinates = async (location) => {
  const sanitizedLocation = location.toLowerCase().replace(/[^a-z0-9]/g, "");
  const cacheKey = `coords:${sanitizedLocation}`;

  const cachedCoords = await redis.get(cacheKey);
  if (cachedCoords) {
    logger.info({ location }, `Cache HIT for coordinates`);
    return JSON.parse(cachedCoords);
  }

  logger.info(
    { location },
    `Cache MISS for coordinates. Calling OpenCage API.`
  );
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

// --- CENTRALIZED TOKEN MANAGEMENT IN REDIS ---
const PETFINDER_TOKEN_KEY = "petfinder_token";
const fetchAndCachePetfinderToken = async () => {
  logger.info("Fetching new Petfinder token...");
  try {
    const response = await axios.post(
      "https://api.petfinder.com/v2/oauth2/token",
      querystring.stringify({
        grant_type: "client_credentials",
        client_id: process.env.PETFINDER_CLIENT_ID,
        client_secret: process.env.PETFINDER_CLIENT_SECRET,
      })
    );
    const { access_token, expires_in } = response.data;
    await redis.set(PETFINDER_TOKEN_KEY, access_token, "EX", expires_in - 60);
    logger.info("Successfully fetched and cached new token.");
    return access_token;
  } catch (error) {
    logger.error(
      { err: error.response?.data || error.message },
      "Error fetching Petfinder token"
    );
    throw new Error("Could not fetch token from Petfinder");
  }
};
const addPetfinderToken = async (req, res, next) => {
  try {
    let token = await redis.get(PETFINDER_TOKEN_KEY);
    if (!token) {
      token = await fetchAndCachePetfinderToken();
    }
    req.petfinderToken = token;
    next();
  } catch (error) {
    res
      .status(500)
      .json({ message: "Could not authenticate with Petfinder API" });
  }
};

// --- ROUTES ---
app.get("/", (req, res) => res.send("Pawadopt Server is running!"));

// index.js

app.get("/api/animals", addPetfinderToken, async (req, res) => {
  const cacheKey = `animals:enriched:${querystring.stringify(req.query)}`;
  try {
    const cachedData = await redis.get(cacheKey);
    if (cachedData) {
      res.setHeader("X-Cache", "HIT");
      return res.json(JSON.parse(cachedData));
    }
    res.setHeader("X-Cache", "MISS");

    // Step 1: Fetch the basic animal list from Petfinder
    const petfinderResponse = await axios.get(
      "https://api.petfinder.com/v2/animals",
      {
        headers: { Authorization: `Bearer ${req.petfinderToken}` },
        params: req.query,
      }
    );
    const data = petfinderResponse.data;
    if (!data.animals || data.animals.length === 0) {
      return res.json(data);
    }

    // --- NEW DATA ENRICHMENT LOGIC ---

    // Step 2: Gather org IDs and check your local database first
    const orgIds = [...new Set(data.animals.map((a) => a.organization_id))];
    const existingOrgs = await prisma.organization.findMany({
      where: { id: { in: orgIds } },
    });
    const existingOrgIds = new Set(existingOrgs.map((o) => o.id));

    // Step 3: Identify which organization details are missing
    const missingOrgIds = orgIds.filter((id) => !existingOrgIds.has(id));
    const newOrgs = [];

    // Step 4: Fetch only the missing organizations from Petfinder
    if (missingOrgIds.length > 0) {
      logger.info(
        `Fetching ${missingOrgIds.length} missing organizations from Petfinder API.`
      );
      const token = req.petfinderToken; // Use the token from the middleware
      const orgPromises = missingOrgIds.map((orgId) =>
        axios
          .get(`https://api.petfinder.com/v2/organizations/${orgId}`, {
            headers: { Authorization: `Bearer ${token}` },
          })
          .then((response) => response.data.organization)
          .catch((err) => {
            logger.warn(
              { orgId, err: err.message },
              "Could not fetch a single organization."
            );
            return null;
          })
      );

      const fetchedOrgs = (await Promise.all(orgPromises)).filter(Boolean);

      // Step 5: Save the newly fetched organizations to your database for next time
      if (fetchedOrgs.length > 0) {
        newOrgs.push(...fetchedOrgs);
        await prisma.organization.createMany({
          data: fetchedOrgs.map((orgData) => ({
            id: orgData.id,
            name: orgData.name,
            email: orgData.email,
            phone: orgData.phone,
            address: orgData.address,
            url: orgData.url,
          })),
          skipDuplicates: true, // Ignore if another process added it in the meantime
        });
      }
    }

    // Step 6: Combine existing and new orgs, and attach them to the animals
    const allOrgs = [...existingOrgs, ...newOrgs];
    data.animals.forEach((animal) => {
      animal.organization =
        allOrgs.find((org) => org.id === animal.organization_id) || null;
    });
    // --- END OF ENRICHMENT LOGIC ---

    await redis.set(cacheKey, JSON.stringify(data), "EX", 3600);
    res.json(data);
  } catch (error) {
    logger.error(
      { err: error.response?.data || error.message, query: req.query },
      "Error in /api/animals"
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
        include: { organization: true }, // Include the organization data
      });
      const orderedAnimals = pageIds
        .map((id) => animalsData.find((a) => a.id === id))
        .filter(Boolean);
      return res.json({
        animals: orderedAnimals,
        pagination: { currentPage: page, totalPages, sessionId },
      });
    }

    logger.info({ location }, "Creating new video session");
    const coords = await getUserCoordinates(location);
    const userLat = coords.lat;
    const userLon = coords.lon;
    const searchRadiusMiles = 150;
    const localCandidates = await prisma.$queryRaw`
        SELECT id FROM "AnimalWithVideo"
        WHERE latitude IS NOT NULL AND longitude IS NOT NULL AND
        (6371 * acos(LEAST(1.0, GREATEST(-1.0, cos(radians(${userLat})) * cos(radians(latitude)) * cos(radians(longitude) - radians(${userLon})) + sin(radians(${userLat})) * sin(radians(latitude)))))) < ${
      searchRadiusMiles * 1.60934
    }
        LIMIT 500;
    `;
    const localIds = localCandidates.map((c) => c.id);
    const nationwideCandidates = await prisma.animalWithVideo.findMany({
      take: 200,
      select: { id: true },
      where: { id: { notIn: localIds } },
    });
    const nationwideIds = nationwideCandidates.map((c) => c.id);

    for (let i = localIds.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [localIds[i], localIds[j]] = [localIds[j], localIds[i]];
    }
    for (let i = nationwideIds.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [nationwideIds[i], nationwideIds[j]] = [
        nationwideIds[j],
        nationwideIds[i],
      ];
    }

    const finalPlaylist = [];
    let localIndex = 0;
    let nationwideIndex = 0;
    const localRatio = 3;
    while (
      localIndex < localIds.length &&
      nationwideIndex < nationwideIds.length
    ) {
      for (let i = 0; i < localRatio && localIndex < localIds.length; i++) {
        finalPlaylist.push(localIds[localIndex++]);
      }
      finalPlaylist.push(nationwideIds[nationwideIndex++]);
    }
    finalPlaylist.push(...localIds.slice(localIndex));
    finalPlaylist.push(...nationwideIds.slice(nationwideIndex));

    const newSessionId = randomUUID();
    await redis.set(
      `session:${newSessionId}`,
      JSON.stringify(finalPlaylist),
      "EX",
      7200
    );
    const totalPages = Math.ceil(finalPlaylist.length / PAGE_SIZE);
    const pageIds = finalPlaylist.slice(0, PAGE_SIZE);
    if (pageIds.length === 0) {
      return res.json({
        animals: [],
        pagination: { currentPage: 1, totalPages, sessionId: newSessionId },
      });
    }
    const pageData = await prisma.animalWithVideo.findMany({
      where: { id: { in: pageIds } },
      include: { organization: true }, // Include the organization data
    });
    const orderedAnimals = pageIds
      .map((id) => pageData.find((a) => a.id === id))
      .filter(Boolean);
    res.json({
      animals: orderedAnimals,
      pagination: { currentPage: 1, totalPages, sessionId: newSessionId },
    });
  } catch (error) {
    logger.error({ err: error, body: req.body }, "Error in /api/videos");
    res.status(500).json({ message: "Failed to fetch video feed." });
  }
});

app.get("/api/animal/:id", async (req, res) => {
  const animalId = parseInt(req.params.id);
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
    logger.error(
      { err: error, animalId: req.params.id },
      "Error fetching single animal"
    );
    res.status(500).json({ message: "An error occurred." });
  }
});

app.post("/api/animal/:id/like", async (req, res) => {
  const animalId = parseInt(req.params.id);
  const { action } = req.body;
  if (isNaN(animalId) || !["like", "unlike"].includes(action)) {
    return res.status(400).json({ message: "Invalid request." });
  }
  try {
    const updatedAnimal = await prisma.animalWithVideo.update({
      where: { id: animalId },
      data: {
        likeCount: action === "like" ? { increment: 1 } : { decrement: 1 },
      },
      select: { likeCount: true },
    });
    res.json({ newLikeCount: updatedAnimal.likeCount });
  } catch (error) {
    logger.error(
      { err: error, animalId: req.params.id, action },
      "Error updating like count"
    );
    res.status(500).json({ message: "Could not update like count." });
  }
});

app.get("/api/force-refresh-token", async (req, res) => {
  // Simple security check to ensure only you can run this
  if (req.query.secret !== process.env.REFRESH_TOKEN_SECRET) {
    return res.status(401).json({ message: "Unauthorized" });
  }

  try {
    await fetchAndCachePetfinderToken();
    res
      .status(200)
      .json({ message: "Petfinder token has been successfully refreshed." });
  } catch (error) {
    res.status(500).json({ message: "Failed to refresh token." });
  }
});

// --- SERVER START ---
app.listen(port, () => {
  logger.info(`✅ Server listening on http://localhost:${port}`);
});
