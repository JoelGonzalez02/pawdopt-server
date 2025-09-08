// server.js

// --- IMPORTS ---
import express from "express";
import Redis from "ioredis";
import axios from "axios";
import dotenv from "dotenv";
import cors from "cors";
import querystring from "querystring";
import cron from "node-cron";
import { buildReelsCache, buildReelsForLocation } from "./worker.js";

// --- CONFIGURATION ---
dotenv.config();

const app = express();
const port = process.env.PORT || 3000;
const redis = new Redis(process.env.REDIS_URL);

app.use(cors());
app.use(express.json());

const REELS_CACHE_KEY = "reels:all_animals";
const LOCATION_REELS_CACHE_PREFIX = "reels:location:";

// --- PETFINDER TOKEN MANAGEMENT ---
let petfinderToken = {
  token: null,
  expiresAt: 0,
};

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
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
      }
    );

    const { access_token, expires_in } = response.data;
    const expiresAt = Date.now() + expires_in * 1000;
    petfinderToken = { token: access_token, expiresAt };

    console.log("Successfully fetched new token.");
    return access_token;
  } catch (error) {
    console.error(
      "Error fetching Petfinder token:",
      error.response?.data || error.message
    );
    throw new Error("Could not fetch token from Petfinder");
  }
};

const addPetfinderToken = async (req, res, next) => {
  if (!petfinderToken.token || Date.now() >= petfinderToken.expiresAt - 60000) {
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
app.get("/", (req, res) => {
  res.send("PawBond Server is running!");
});

app.get("/api/animals", addPetfinderToken, async (req, res) => {
  try {
    const cacheKey = `animals:${JSON.stringify(req.query)}`;
    const cachedData = await redis.get(cacheKey);

    if (cachedData) {
      console.log(`CACHE HIT for key: ${cacheKey}`);
      return res.json(JSON.parse(cachedData));
    }

    console.log(`CACHE MISS for key: ${cacheKey}`);
    const petfinderResponse = await axios.get(
      "https://api.petfinder.com/v2/animals",
      {
        headers: { Authorization: `Bearer ${req.petfinderToken}` },
        params: req.query,
      }
    );
    const data = petfinderResponse.data;
    await redis.set(cacheKey, JSON.stringify(data), "EX", 600);
    res.json(data);
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

app.post("/api/prewarm-reels", addPetfinderToken, async (req, res) => {
  const { location } = req.body;

  if (!location) {
    return res.status(400).json({ message: "Location is required." });
  }

  const sanitizedLocation = location.split(",").slice(0, 2).join(",").trim();
  const locationCacheKey = `${LOCATION_REELS_CACHE_PREFIX}${sanitizedLocation}`;

  try {
    const alreadyCached = await redis.get(locationCacheKey);
    if (alreadyCached) {
      console.log(
        `PRE-WARM: Cache already exists for ${sanitizedLocation}. Skipping.`
      );
      return res.status(200).json({ message: "Cache already warm." });
    }

    res.status(202).json({ message: "Reels cache pre-warming initiated." });

    console.log(
      `PRE-WARM: Starting background cache build for ${sanitizedLocation}.`
    );
    buildReelsForLocation(redis, req.petfinderToken, sanitizedLocation);
  } catch (error) {
    console.error("Error during pre-warm request:", error.message);
    if (!res.headersSent) {
      res.status(500).json({ message: "Internal server error." });
    }
  }
});

app.get("/api/reels", addPetfinderToken, async (req, res) => {
  const { location } = req.query;

  try {
    if (location) {
      const sanitizedLocation = location
        .split(",")
        .slice(0, 2)
        .join(",")
        .trim();
      console.log(
        `Handling "For You" request for location: "${sanitizedLocation}"`
      );
      const locationCacheKey = `${LOCATION_REELS_CACHE_PREFIX}${sanitizedLocation}`;

      const cachedReels = await redis.get(locationCacheKey);
      if (cachedReels) {
        console.log(`CACHE HIT for location: ${sanitizedLocation}`);
        return res.json(JSON.parse(cachedReels));
      }

      console.log(
        `CACHE MISS for location: ${sanitizedLocation}. Building now...`
      );
      const newReels = await buildReelsForLocation(
        redis,
        req.petfinderToken,
        sanitizedLocation
      );
      return res.json({ animals: newReels });
    } else {
      console.log('Handling "All" reels request.');
      const cachedReels = await redis.get(REELS_CACHE_KEY);
      if (cachedReels) {
        console.log(`CACHE HIT for generic reels.`);
        return res.json(JSON.parse(cachedReels));
      }

      console.log(`CACHE MISS for generic reels. Returning empty array.`);
      return res.json({ animals: [] });
    }
  } catch (error) {
    console.error("Error in /api/reels:", error.message);
    return res
      .status(500)
      .json({ message: "An error occurred while fetching video reels." });
  }
});

// --- SCHEDULED WORKER & INITIALIZATION ---
const runGenericReelsWorker = async () => {
  console.log("WORKER-RUNNER: Starting the generic reels cache worker...");
  try {
    const token = await fetchPetfinderToken();
    await buildReelsCache(redis, token);
  } catch (error) {
    console.error("WORKER-RUNNER: Generic worker task failed:", error.message);
  }
};

cron.schedule("*/30 * * * *", runGenericReelsWorker);

// --- START THE SERVER ---
app.listen(port, () => {
  console.log(`Server listening on http://localhost:${port}`);
  runGenericReelsWorker();
});
