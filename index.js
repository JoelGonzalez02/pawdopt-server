// --- IMPORTS ---
import express from "express";
import dotenv from "dotenv";
import axios from "axios";
import querystring from "querystring";
import { PrismaClient } from "@prisma/client";

// --- CONFIGURATION ---
dotenv.config();
const app = express();
const port = process.env.PORT || 3000;
const prisma = new PrismaClient();
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
    const petfinderResponse = await axios.get(
      "https://api.petfinder.com/v2/animals",
      {
        headers: { Authorization: `Bearer ${req.petfinderToken}` },
        params: req.query,
      }
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

// The new, intelligent "Smart Feed" endpoint
app.post("/api/next-videos", async (req, res) => {
  const { location, distance } = req.body;
  const BATCH_SIZE = 10;

  if (!location) {
    return res.status(400).json({ message: "Location is required." });
  }

  try {
    // 1. Fetch local animals
    const [city, state] = location.split(",").map((s) => s.trim());
    const localAnimals = await prisma.animalWithVideo.findMany({
      where: { city, state },
      take: 50, // Fetch a good-sized batch of local options
    });

    // 2. Fetch random nationwide animals
    const totalCount = await prisma.animalWithVideo.count();
    const skip = Math.max(0, Math.floor(Math.random() * totalCount) - 20);
    const randomAnimals = await prisma.animalWithVideo.findMany({
      skip: skip < 0 ? 0 : skip,
      take: 20, // Fetch a smaller batch for variety
    });

    // 3. Blend the two lists and remove duplicates
    const localIds = new Set(localAnimals.map((a) => a.id));
    const uniqueRandom = randomAnimals.filter((a) => !localIds.has(a.id));
    let blendedFeed = [...localAnimals, ...uniqueRandom];

    // 4. Shuffle the final blended feed
    for (let i = blendedFeed.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [blendedFeed[i], blendedFeed[j]] = [blendedFeed[j], blendedFeed[i]];
    }

    // 5. Serve the next batch of videos
    const nextBatch = blendedFeed
      .slice(0, BATCH_SIZE)
      .map((animal) => animal.rawJson);

    res.json({ animals: nextBatch });
  } catch (error) {
    console.error("Error in /api/next-videos:", error);
    res.status(500).json({ message: "Failed to get next videos." });
  }
});

app.listen(port, () => {
  console.log(`Server listening on http://localhost:${port}`);
});
