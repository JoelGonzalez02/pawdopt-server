// refresh-worker.js
import { PrismaClient } from "@prisma/client";
import Redis from "ioredis";
import axios from "axios";
import dotenv from "dotenv";
import querystring from "querystring";
import cron from "node-cron";
import axiosRetry from "axios-retry";
import { makeApiCallWithCount } from "./utils/apiTracker.js";

// --- CONFIGURATION ---
dotenv.config();
const PETFINDER_API_URL = "https://api.petfinder.com/v2/animals";
const PETFINDER_TOKEN_KEY = "petfinder_token";

const REFRESH_THRESHOLD_HOURS = 23;
const BATCH_LIMIT = 20;
const HOURLY_API_BUDGET = 40;
const API_DELAY_MS = 2000; // Delay between batches

// --- INITIALIZATION ---
const prisma = new PrismaClient();
const redis = new Redis(process.env.REDIS_URL);
redis.on("error", (err) => console.error("HOURLY REFRESH: Redis Error", err));
redis.on("connect", () => console.log("HOURLY REFRESH: Connected to Redis."));

axiosRetry(axios, {
  retries: 3,
  retryDelay: (retryCount) => {
    console.log(`Request failed, retrying in ${retryCount * 2} seconds...`);
    return retryCount * 2000;
  },
  retryCondition: (error) => {
    return (
      axiosRetry.isNetworkError(error) ||
      (error.response &&
        error.response.status >= 500 &&
        error.response.status <= 599)
    );
  },
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
  // 1. Check for existing token first
  let token = await redis.get(PETFINDER_TOKEN_KEY);
  if (token) return token;

  // 2. Implement a lock to prevent multiple workers from fetching a token simultaneously
  const lockKey = `${PETFINDER_TOKEN_KEY}_lock`;
  const lock = await redis.set(lockKey, "1", "EX", 10, "NX"); // Set a lock with a 10-second expiry

  if (!lock) {
    // Could not get the lock, another process is fetching. Wait and retry.
    console.log("HOURLY REFRESH: Waiting for token lock to release...");
    await delay(2000); // Wait 2 seconds before retrying
    return getValidToken();
  }

  try {
    // 3. Re-check for the token in case it was set while we acquired the lock
    token = await redis.get(PETFINDER_TOKEN_KEY);
    if (token) return token;

    console.log("HOURLY REFRESH: Lock acquired. Fetching new token...");
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
    return access_token;
  } catch (error) {
    console.error(
      "HOURLY REFRESH: Could not fetch Petfinder token.",
      error.response?.data || error.message
    );
    throw new Error("Could not authenticate with Petfinder.");
  } finally {
    // 4. IMPORTANT: Always release the lock
    await redis.del(lockKey);
  }
};

// --- MAIN PROCESSING LOGIC ---
const runHourlyRefresh = async () => {
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

    // 1. Create an array of API call promises for the entire batch
    const apiCallPromises = animalsToAudit.map((animal) =>
      makeApiCallWithCount(() =>
        axios.get(`${PETFINDER_API_URL}/${animal.id}`, {
          headers: { Authorization: `Bearer ${token}` },
        })
      )
    );

    // 2. Execute all promises concurrently and get their results
    const results = await Promise.allSettled(apiCallPromises);

    const updatePromises = [];
    const deletePromises = [];

    // 3. Loop through the results to build your database operations
    results.forEach((result, index) => {
      const originalAnimal = animalsToAudit[index];

      if (result.status === "fulfilled") {
        const animalData = result.value.data.animal;
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

    // 4. Execute all database operations in a single, efficient transaction
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

    // A single delay between batches is more efficient
    if (hasMoreAnimals) {
      await delay(API_DELAY_MS);
    }
  }

  console.log(
    `HOURLY REFRESH: Job complete. Total animals processed this run: ${totalProcessed}.`
  );
};

// --- SCHEDULER ---
console.log("REFRESH: Worker started. Waiting for schedule (runs every hour).");

cron.schedule("0 * * * *", () => {
  console.log(
    `--- [${new Date().toLocaleString()}] Running Hourly Refresh Job ---`
  );
  withRetry(runHourlyRefresh, 3, 60000).catch((e) => {
    console.error("HOURLY REFRESH: Job failed after all retries.", e);
  });
});

// --- MANUAL EXECUTION ---
// To run this script on-demand, comment out the cron.schedule block above
// and uncomment the block below.

// runHourlyRefresh()
//   .then(async () => {
//     console.log("REFRESH: Manual scan complete. Disconnecting.");
//     await prisma.$disconnect();
//     await redis.quit();
//   })
//   .catch(async (e) => {
//     console.error("Quick Scan: A fatal error occurred:", e);
//     await prisma.$disconnect();
//     await redis.quit();
//     process.exit(1);
//   });
