// --- IMPORTS ---
import express from "express";
import Redis from "ioredis";
import axios from "axios";
import dotenv from "dotenv";
import cors from "cors";
import querystring from "querystring";
import cron from "node-cron"; // Import the scheduler
import { buildReelsCache } from "./worker.js"; // Import your worker function

// --- CONFIGURATION ---
dotenv.config();

const app = express();
const port = process.env.PORT || 3000;
const redis = new Redis(process.env.REDIS_URL);

app.use(cors());
app.use(express.json());

const REELS_CACHE_KEY = "reels:all_animals";

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

app.get("/api/reels", async (req, res) => {
  try {
    const cachedReels = await redis.get(REELS_CACHE_KEY);
    if (cachedReels) {
      console.log(`CACHE HIT for key: ${REELS_CACHE_KEY}`);
      return res.json(JSON.parse(cachedReels));
    }
    console.log(
      `CACHE MISS for key: ${REELS_CACHE_KEY}. The worker may need to run.`
    );
    res.json({ animals: [] });
  } catch (error) {
    console.error("Error in /api/reels:", error.message);
    res
      .status(500)
      .json({ message: "An error occurred while fetching video reels." });
  }
});

// --- SCHEDULED WORKER & INITIALIZATION ---

// Define a single function to run the worker logic
const runReelsWorker = async () => {
  console.log("WORKER-RUNNER: Starting the reels cache worker...");
  try {
    // A valid token is required for the worker to function
    const token = await fetchPetfinderToken();
    await buildReelsCache(redis, token);
  } catch (error) {
    console.error("WORKER-RUNNER: Worker task failed:", error.message);
  }
};

// Schedule the worker to run every 30 minutes
cron.schedule("*/30 * * * *", runReelsWorker);

// --- START THE SERVER ---
app.listen(port, () => {
  console.log(`Server listening on http://localhost:${port}`);
  // Run the worker once immediately on startup
  console.log("SERVER STARTUP: Triggering initial run of the reels worker.");
  runReelsWorker();
});
