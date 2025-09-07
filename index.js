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

// Simple Reels endpoint that serves from one global cache
app.get("/api/reels", async (req, res) => {
  try {
    const cachedReels = await redis.get("reels:all_animals");
    if (cachedReels) {
      const data = JSON.parse(cachedReels);
      data.animals.sort(() => Math.random() - 0.5);
      return res.json(data);
    } else {
      console.log("REELS MISS: No pre-compiled list found.");
      return res.json({ animals: [], message: "Reels are being prepared." });
    }
  } catch (error) {
    console.error("Error fetching reels from cache:", error);
    res.status(500).json({ message: "Could not fetch reels." });
  }
});

// Endpoint for standard animal searches
app.get("/api/animals", addPetfinderToken, async (req, res) => {
  // ... (implementation remains the same)
});

// --- BACKGROUND JOB SCHEDULER ---
const scheduleReelsWorker = () => {
  cron.schedule("0 * * * *", async () => {
    console.log("SCHEDULER: Triggering hourly reels cache build.");
    try {
      const token =
        (await redis.get(PETFINDER_TOKEN_KEY)) || (await fetchPetfinderToken());
      await buildReelsCache(redis, token);
    } catch (error) {
      console.error("SCHEDULER: Failed to run the reels worker.", error);
    }
  });

  console.log("SERVER START: Running initial reels cache build.");
  (async () => {
    try {
      const token =
        (await redis.get(PETFINDER_TOKEN_KEY)) || (await fetchPetfinderToken());
      await buildReelsCache(redis, token);
    } catch (error) {
      console.error("SERVER START: Failed to run initial reels worker.", error);
    }
  })();
};

// --- START THE SERVER ---
app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
  scheduleReelsWorker();
});
