// --- IMPORTS ---
import express from "express";
import Redis from "ioredis";
import axios from "axios";
import dotenv from "dotenv";
import cors from "cors";
import querystring from "querystring";
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

// --- PETFINDER TOKEN MANAGEMENT (Unchanged) ---
const PETFINDER_TOKEN_KEY = "petfinder_token";

const fetchPetfinderToken = async () => {
  // ... implementation is the same
};

const addPetfinderToken = async (req, res, next) => {
  // ... implementation is the same
};

// --- HELPERS (Unchanged) ---
const getCacheKey = (queryParams) => {
  // ... implementation is the same
};

// --- ROUTES ---

app.get("/", (req, res) => {
  res.send("PawBond Server is running!");
});

// --- UPDATED REELS ENDPOINT ---
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
      data.animals.sort(() => Math.random() - 0.5); // Shuffle for variety
      return res.json(data);
    } else {
      console.log(`REELS MISS: No list found for ${location}. Building now...`);

      // 1. Get a token for the worker
      const token =
        (await redis.get(PETFINDER_TOKEN_KEY)) || (await fetchPetfinderToken());

      // 2. Run the worker and WAIT for it to finish
      await buildReelsCache(redis, token, location);

      // 3. After the worker is done, get the new data from the cache
      const newCachedReels = await redis.get(cacheKey);

      console.log(`REELS: Sending newly built list for ${location}.`);
      const data = JSON.parse(newCachedReels || '{"animals":[]}'); // Fallback for empty result
      data.animals.sort(() => Math.random() - 0.5);
      return res.json(data);
    }
  } catch (error) {
    console.error("Error in /api/reels endpoint:", error);
    res.status(500).json({ message: "Could not fetch reels." });
  }
});

// --- EXISTING ANIMALS ENDPOINT (Unchanged) ---
app.get("/api/animals", addPetfinderToken, async (req, res) => {
  // ... implementation is the same
});

// --- START THE SERVER ---
app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
  // The startup and scheduled jobs are no longer needed with the on-demand system
});
