// api/crons/refresh.js
import { PrismaClient } from "@prisma/client";
import Redis from "ioredis";
import axios from "axios";
import axiosRetry from "axios-retry";
import dotenv from "dotenv";
import querystring from "querystring";
import { makeApiCallWithCount } from "../utils/apiTracker.js"; // Note: updated path for Vercel

// --- CONFIGURATION ---
dotenv.config();
const PETFINDER_API_URL = "https://api.petfinder.com/v2/animals";
const PETFINDER_TOKEN_KEY = "petfinder_token";

const REFRESH_THRESHOLD_HOURS = 23;
const BATCH_LIMIT = 20;
const HOURLY_API_BUDGET = 100; // Increased budget for robustness
const API_DELAY_MS = 2000; // Delay between batches

// --- INITIALIZATION ---
const prisma = new PrismaClient();
const redis = new Redis(process.env.REDIS_URL);

axiosRetry(axios, {
  retries: 3,
  retryDelay: (retryCount) => {
    console.log(`Request failed, retrying in ${retryCount * 2} seconds...`);
    return retryCount * 2000;
  },
  retryCondition: (error) =>
    axiosRetry.isNetworkError(error) ||
    (error.response && error.response.status >= 500),
});

// --- HELPER FUNCTIONS ---
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const withRetry = async (fn, retries = 3, delayMs = 60000) => {
  let lastError;
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (i < retries - 1) {
        console.log(
          `HOURLY REFRESH: Operation failed. Retrying in ${
            delayMs / 1000
          }s... (Attempt ${i + 1}/${retries})`
        );
        await delay(delayMs);
      }
    }
  }
  throw lastError;
};

const getValidToken = async () => {
  let token = await redis.get(PETFINDER_TOKEN_KEY);
  if (token) return token;

  const lockKey = `${PETFINDER_TOKEN_KEY}_lock`;
  if (await redis.set(lockKey, "1", "EX", 10, "NX")) {
    try {
      console.log("HOURLY REFRESH: No valid token, fetching new one...");
      const response = await makeApiCallWithCount(() =>
        axios.post(
          "https://api.petfinder.com/v2/oauth2/token",
          querystring.stringify({
            grant_type: "client_credentials",
            client_id: process.env.PETFINDER_CLIENT_ID,
            client_secret: process.env.PETFINDER_CLIENT_SECRET,
          })
        )
      );
      const { access_token, expires_in } = response.data;
      await redis.set(PETFINDER_TOKEN_KEY, access_token, "EX", expires_in - 60);
      await delay(2000);
      return access_token;
    } finally {
      await redis.del(lockKey);
    }
  } else {
    await delay(2000);
    return getValidToken();
  }
};

// --- MAIN PROCESSING LOGIC ---
async function runHourlyRefresh() {
  console.log("HOURLY REFRESH: Starting hourly refresh job...");
  const token = await getValidToken();

  let totalProcessed = 0;
  let hasMoreAnimals = true;

  while (hasMoreAnimals && totalProcessed < HOURLY_API_BUDGET) {
    const cutoffDate = new Date();
    cutoffDate.setHours(cutoffDate.getHours() - REFRESH_THRESHOLD_HOURS);

    const animalsToAudit = await prisma.animalWithVideo.findMany({
      where: { lastSeenAt: { lt: cutoffDate } },
      orderBy: { lastSeenAt: "asc" },
      take: BATCH_LIMIT,
    });

    if (animalsToAudit.length === 0) {
      if (totalProcessed === 0) {
        console.log(
          "HOURLY REFRESH: No animals found nearing the 24-hour mark."
        );
      }
      break;
    }

    hasMoreAnimals = animalsToAudit.length === BATCH_LIMIT;
    console.log(
      `HOURLY REFRESH: Found a batch of ${animalsToAudit.length} animals. Processing concurrently...`
    );

    const apiCallPromises = animalsToAudit.map((animal) =>
      makeApiCallWithCount(() =>
        axios.get(`${PETFINDER_API_URL}/${animal.id}`, {
          headers: { Authorization: `Bearer ${token}` },
        })
      )
    );

    const results = await Promise.allSettled(apiCallPromises);
    const updatePromises = [];
    const deletePromises = [];

    results.forEach((result, index) => {
      const originalAnimal = animalsToAudit[index];
      if (result.status === "fulfilled") {
        const animalData = result.value.data.animal;
        // FIX: Explicitly map all fields to match your schema perfectly.
        updatePromises.push(
          prisma.animalWithVideo.update({
            where: { id: originalAnimal.id },
            data: {
              name: animalData.name,
              url: animalData.url,
              type: animalData.type,
              age: animalData.age,
              gender: animalData.gender,
              size: animalData.size,
              status: animalData.status,
              breeds: animalData.breeds,
              colors: animalData.colors,
              photos: animalData.photos,
              videos: animalData.videos,
              contact: animalData.contact,
              attributes: animalData.attributes,
              environment: animalData.environment,
              city: animalData.contact.address.city,
              state: animalData.contact.address.state,
            },
          })
        );
      } else {
        if (result.reason.response?.status === 404) {
          deletePromises.push(
            prisma.animalWithVideo.delete({ where: { id: originalAnimal.id } })
          );
        } else {
          console.error(
            `HOURLY REFRESH: Failed to audit animal ID ${originalAnimal.id}. Error: ${result.reason.message}`
          );
        }
      }
    });

    if (updatePromises.length > 0 || deletePromises.length > 0) {
      await prisma.$transaction([...updatePromises, ...deletePromises]);
      console.log(
        `HOURLY REFRESH: ==> Batch complete. Updated: ${updatePromises.length}, Deleted: ${deletePromises.length}.`
      );
    }

    totalProcessed += animalsToAudit.length;
    if (totalProcessed >= HOURLY_API_BUDGET) {
      console.log(
        "HOURLY REFRESH: Hourly API budget reached. Will continue on next run."
      );
      break;
    }

    if (hasMoreAnimals) {
      await delay(API_DELAY_MS);
    }
  }

  console.log(
    `HOURLY REFRESH: Job complete. Total animals processed this run: ${totalProcessed}.`
  );
}

// --- VERCEL SERVERLESS FUNCTION HANDLER ---
export default async function handler(req, res) {
  try {
    // The withRetry logic is perfect for handling transient errors in a serverless context.
    await withRetry(runHourlyRefresh, 3, 60000);
    res.status(200).send("Refresh job completed successfully.");
  } catch (error) {
    console.error("HOURLY REFRESH: Job failed after all retries.", error);
    res.status(500).send("Refresh job failed.");
  }
}
