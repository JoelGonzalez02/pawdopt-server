// server.js

// --- IMPORTS ---
import express from "express";
import Redis from "ioredis";
import dotenv from "dotenv";
import cron from "node-cron";
import axios from "axios";
import querystring from "querystring";
import { buildFeedUnit } from "./worker.js";

// --- CONFIGURATION ---
dotenv.config();
const app = express();
const port = process.env.PORT || 3000;
const redis = new Redis(process.env.REDIS_URL);
app.use(express.json());

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
      expiresAt: Date.now() + expires_in * 1000,
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
app.get("/", (req, res) => res.send("Pawadopt Server is running!"));

// Main endpoint for the discovery/swipe card screen
app.get("/api/animals", addPetfinderToken, async (req, res) => {
  try {
    const cacheKey = `animals:${JSON.stringify(req.query)}`;
    const cachedData = await redis.get(cacheKey);
    if (cachedData) {
      return res.json(JSON.parse(cachedData));
    }
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
      600
    ); // 10-minute cache
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

// Intelligent endpoint for the Reels screen
app.get("/api/feed", addPetfinderToken, async (req, res) => {
  const { context, page = 1, location, distance, type } = req.query;
  const pageSize = 10;

  const cacheKey = `feed:${context}:${location}:${distance}:${type || "all"}`;
  const lockKey = `lock:${cacheKey}`;

  try {
    let feedUnitData = await redis.get(cacheKey);

    if (!feedUnitData) {
      const lock = await redis.get(lockKey);
      if (lock) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        feedUnitData = await redis.get(cacheKey);
      } else {
        await redis.set(lockKey, "1", "EX", 60);
        await buildFeedUnit(redis, req.petfinderToken, {
          context,
          location,
          distance,
          type,
        });
        feedUnitData = await redis.get(cacheKey);
      }
    }

    const feedUnit = JSON.parse(feedUnitData || '{"animals":[]}');
    const totalAnimals = feedUnit.animals.length;
    const startIndex = (page - 1) * pageSize;
    const paginatedAnimals = feedUnit.animals.slice(
      startIndex,
      startIndex + pageSize
    );

    res.json({
      animals: paginatedAnimals,
      totalPages: Math.ceil(totalAnimals / pageSize),
    });
  } catch (error) {
    console.error("Error in /api/feed:", error.message);
    res.status(500).json({ message: "Failed to get feed." });
  }
});

// --- SCHEDULED WORKER ---
const warmPopularFeeds = async () => {
  console.log("CRON: Proactively warming popular feeds...");
  try {
    const token = await fetchPetfinderToken();
    await buildFeedUnit(redis, token, { context: "discover" });
    // This could be expanded to include popular locations as well
  } catch (error) {
    console.error("CRON: Failed to warm popular feeds:", error.message);
  }
};

cron.schedule("0 * * * *", warmPopularFeeds); // Run once an hour

// --- START THE SERVER ---
app.listen(port, () => {
  console.log(`Server listening on http://localhost:${port}`);
  warmPopularFeeds(); // Warm the Discover feed on initial startup
});
