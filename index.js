// --- IMPORTS ---
import express from "express";
import Redis from "ioredis";
import axios from "axios";
import dotenv from "dotenv";
import cors from "cors";
import querystring from "querystring";
import cron from "node-cron";
import { buildReelsCache } from "./worker.js";

// --- CONFIGURATION ---
dotenv.config();

const app = express();
const port = process.env.PORT || 3000;
const redis = new Redis(process.env.REDIS_URL);

redis.on("error", (err) => console.error("Redis Client Error", err));
redis.on("connect", () => console.log("Successfully connected to Redis."));

app.use(cors());
app.use(express.json());

// --- PETFINDER TOKEN MANAGEMENT ---
const PETFINDER_TOKEN_KEY = "petfinder_token";

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
    await redis.set(PETFINDER_TOKEN_KEY, access_token, "EX", expires_in - 60);

    console.log("Successfully fetched and cached new token in Redis.");
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
  try {
    let token = await redis.get(PETFINDER_TOKEN_KEY);
    if (!token) {
      token = await fetchPetfinderToken();
    }
    req.petfinderToken = token;
    next();
  } catch (error) {
    return res
      .status(500)
      .json({ message: "Could not authenticate with Petfinder API" });
  }
};

// --- HELPERS ---
const getCacheKey = (queryParams) => {
  const sortedKeys = Object.keys(queryParams).sort();
  if (sortedKeys.length === 0) {
    return "animals:default";
  }
  const sortedParams = sortedKeys
    .map((key) => `${key}=${queryParams[key]}`)
    .join("&");
  return `animals:${sortedParams}`;
};

// --- ROUTES ---

app.get("/", (req, res) => {
  res.send("PawBond Server is running!");
});

// Reels endpoint with "wait-and-respond" logic
app.get("/api/reels", async (req, res) => {
  const { location } = req.query;
  if (!location) {
    return res.status(400).json({ message: "Location parameter is required." });
  }

  const cacheKey = `reels:${location}`;
  try {
    const cachedReels = await redis.get(cacheKey);
    if (cachedReels) {
      console.log(`REELS HIT: Serving list for ${location} from Redis.`);
      const data = JSON.parse(cachedReels);
      data.animals.sort(() => Math.random() - 0.5);
      return res.json(data);
    } else {
      console.log(`REELS MISS: No list found for ${location}. Building now...`);
      const token =
        (await redis.get(PETFINDER_TOKEN_KEY)) || (await fetchPetfinderToken());

      await buildReelsCache(redis, token, location);

      const newCachedReels = await redis.get(cacheKey);
      console.log(`REELS: Sending newly built list for ${location}.`);
      const data = JSON.parse(newCachedReels || '{"animals":[]}');
      data.animals.sort(() => Math.random() - 0.5);
      return res.json(data);
    }
  } catch (error) {
    console.error("Error in /api/reels endpoint:", error);
    res.status(500).json({ message: "Could not fetch reels." });
  }
});

// Endpoint for standard animal searches
app.get("/api/animals", addPetfinderToken, async (req, res) => {
  const allowedParams = [
    "type",
    "breed",
    "size",
    "gender",
    "age",
    "location",
    "distance",
    "page",
    "limit",
    "sort",
  ];
  const sanitizedQuery = {};
  for (const key of allowedParams) {
    if (req.query[key]) {
      sanitizedQuery[key] = req.query[key];
    }
  }

  const cacheKey = getCacheKey(sanitizedQuery);
  try {
    const cachedData = await redis.get(cacheKey);
    if (cachedData) {
      console.log(`CACHE HIT for key: ${cacheKey}`);
      return res.json(JSON.parse(cachedData));
    }
  } catch (redisError) {
    console.error(`Redis GET error for key ${cacheKey}:`, redisError.message);
  }

  try {
    console.log(`CACHE MISS for key: ${cacheKey}`);
    const petfinderResponse = await axios.get(
      "https://api.petfinder.com/v2/animals",
      {
        headers: { Authorization: `Bearer ${req.petfinderToken}` },
        params: sanitizedQuery,
      }
    );

    const data = petfinderResponse.data;
    try {
      await redis.set(cacheKey, JSON.stringify(data), "EX", 3600); // Cache for 1 hour
    } catch (redisError) {
      console.error(`Redis SET error for key ${cacheKey}:`, redisError.message);
    }

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

// --- BACKGROUND JOB SCHEDULER ---
const scheduleReelsWorker = () => {
  // A default location to pre-warm the cache for
  const defaultLocation = "Long Beach, CA";

  // Run the job at the top of every hour
  cron.schedule("0 * * * *", async () => {
    console.log(
      `SCHEDULER: Triggering hourly cache build for ${defaultLocation}.`
    );
    try {
      const token =
        (await redis.get(PETFINDER_TOKEN_KEY)) || (await fetchPetfinderToken());
      await buildReelsCache(redis, token, defaultLocation);
    } catch (error) {
      console.error("SCHEDULER: Failed to run the reels worker.", error);
    }
  });

  // Also run the job once immediately on server start
  console.log(
    `SERVER START: Running initial cache build for ${defaultLocation}.`
  );
  (async () => {
    try {
      const token =
        (await redis.get(PETFINDER_TOKEN_KEY)) || (await fetchPetfinderToken());
      await buildReelsCache(redis, token, defaultLocation);
    } catch (error) {
      console.error("SERVER START: Failed to run initial reels worker.", error);
    }
  })();
};

// --- START THE SERVER ---
app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
  // Start the background job scheduler and the initial run
  scheduleReelsWorker();
});
