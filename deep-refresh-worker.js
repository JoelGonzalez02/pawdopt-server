/**
 * Pawadopt Deep Refresh Worker
 * ----------------------------
 * This script is a long-running service that runs once every 24 hours.
 * It performs a two-phase refresh to ensure data accuracy and compliance.
 *
 * How to run:
 * In production: pm2 start deep-refresh-worker.js --name="deep-refresh"
 */

// --- IMPORTS ---
import { PrismaClient } from "@prisma/client";
import Redis from "ioredis";
import axios from "axios";
import dotenv from "dotenv";
import querystring from "querystring";
import opencage from "opencage-api-client";
import cron from "node-cron";

// --- CONFIGURATION ---
dotenv.config();
const PETFINDER_API_URL = "https://api.petfinder.com/v2/animals";
const PAGE_LIMIT = 100;
const SCAN_RADIUS_MILES = 150;
const DEEP_REFRESH_PAGES = 3;
const LAST_SCAN_TIMESTAMP_KEY = "worker:last_scan_time";

const CITY_HUBS = [
  "Seattle, WA",
  "Portland, OR",
  "Sacramento, CA",
  "San Francisco, CA",
  "Los Angeles, CA",
  "San Diego, CA",
  "Las Vegas, NV",
  "Phoenix, AZ",
  "Salt Lake City, UT",
  "Denver, CO",
  "Dallas, TX",
  "Houston, TX",
  "San Antonio, TX",
  "New Orleans, LA",
  "Oklahoma City, OK",
  "Kansas City, MO",
  "St. Louis, MO",
  "Minneapolis, MN",
  "Chicago, IL",
  "Indianapolis, IN",
  "Detroit, MI",
  "Nashville, TN",
  "Atlanta, GA",
  "Charlotte, NC",
  "Orlando, FL",
  "Miami, FL",
  "Pittsburgh, PA",
  "Washington, DC",
  "Philadelphia, PA",
  "New York, NY",
  "Boston, MA",
];
const CITY_COORDS_CACHE_KEY = "worker:coords";

// --- INITIALIZATION ---
const prisma = new PrismaClient();
const redis = new Redis(process.env.REDIS_URL);
redis.on("error", (err) => console.error("DEEP REFRESH: Redis Error", err));
redis.on("connect", () => console.log("DEEP REFRESH: Connected to Redis."));

// --- PETFINDER TOKEN MANAGEMENT ---
let petfinderToken = { token: null, expiresAt: 0 };

const getValidToken = async () => {
  if (petfinderToken.token && Date.now() < petfinderToken.expiresAt) {
    return petfinderToken.token;
  }
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
    petfinderToken = {
      token: access_token,
      expiresAt: Date.now() + (expires_in - 60) * 1000,
    };
    return petfinderToken.token;
  } catch (error) {
    console.error(
      "DEEP REFRESH: Could not fetch Petfinder token.",
      error.response?.data || error.message
    );
    throw new Error("Could not authenticate with Petfinder.");
  }
};

// --- HELPER FUNCTIONS ---
const getCityCoordinates = async (city) => {
  const cachedCoords = await redis.hget(CITY_COORDS_CACHE_KEY, city);
  if (cachedCoords) return JSON.parse(cachedCoords);
  console.log(`DEEP REFRESH: Geocoding ${city}...`);
  const data = await opencage.geocode({
    q: city,
    key: process.env.OPENCAGE_API_KEY,
  });
  if (data.status.code === 200 && data.results.length > 0) {
    const { lat, lng } = data.results[0].geometry;
    await redis.hset(CITY_COORDS_CACHE_KEY, city, JSON.stringify({ lat, lng }));
    return { lat, lng };
  }
  throw new Error(`Could not geocode ${city}`);
};

const pruneStaleAnimals = async () => {
  console.log("DEEP REFRESH: Pruning stale records...");
  const cutoffDate = new Date(Date.now() - 25 * 60 * 60 * 1000);
  const { count } = await prisma.animalWithVideo.deleteMany({
    where: { lastSeenAt: { lt: cutoffDate } },
  });
  console.log(`DEEP REFRESH: Pruned ${count} stale animal records.`);
  const orgPruneResult = await prisma.organization.deleteMany({
    where: { animals: { none: {} } },
  });
  if (orgPruneResult.count > 0) {
    console.log(
      `DEEP REFRESH: Pruned ${orgPruneResult.count} stale organization records.`
    );
  }
};

// --- MAIN WORKER ---
const runDeepRefresh = async () => {
  const startTime = new Date();
  console.log(
    `DEEP REFRESH: [${startTime.toLocaleString()}] Starting daily data refresh and pruning...`
  );

  await pruneStaleAnimals();

  // --- PHASE 1: BROAD REFRESH ---
  console.log(
    "DEEP REFRESH: Starting Phase 1: Broad refresh of recent animals..."
  );
  for (const city of CITY_HUBS) {
    try {
      const coords = await getCityCoordinates(city);
      const locationString = `${coords.lat},${coords.lng}`;
      const token = await getValidToken();
      let totalRefreshedInHub = 0;

      for (let page = 1; page <= DEEP_REFRESH_PAGES; page++) {
        const response = await axios.get(PETFINDER_API_URL, {
          headers: { Authorization: `Bearer ${token}` },
          params: {
            limit: PAGE_LIMIT,
            page,
            location: locationString,
            distance: SCAN_RADIUS_MILES,
            sort: "recent",
          },
        });

        const { animals } = response.data;
        if (!animals || animals.length === 0) break;

        const animalIds = animals.map((a) => a.id);
        const { count } = await prisma.animalWithVideo.updateMany({
          where: { id: { in: animalIds } },
          data: { lastSeenAt: new Date() },
        });
        totalRefreshedInHub += count;
      }
      console.log(
        `DEEP REFRESH: Broad refresh for ${city} touched ${totalRefreshedInHub} records.`
      );
    } catch (error) {
      console.error(
        `DEEP REFRESH: Failed to broad-refresh hub ${city}:`,
        error.message
      );
    }
  }

  // --- PHASE 2: TARGETED RE-VALIDATION (SAFETY NET) ---
  console.log(
    "DEEP REFRESH: Starting Phase 2: Targeted re-validation of at-risk animals..."
  );
  try {
    const twentyFiveHoursAgo = new Date(Date.now() - 25 * 60 * 60 * 1000);
    const twentyThreeHoursAgo = new Date(Date.now() - 23 * 60 * 60 * 1000);

    const atRiskAnimals = await prisma.animalWithVideo.findMany({
      where: {
        lastSeenAt: { lt: twentyThreeHoursAgo, gte: twentyFiveHoursAgo },
      },
      select: { id: true },
    });

    if (atRiskAnimals.length > 0) {
      console.log(
        `DEEP REFRESH: Found ${atRiskAnimals.length} at-risk animals to re-validate.`
      );
      let totalRefreshed = 0;
      const token = await getValidToken();

      for (const animal of atRiskAnimals) {
        try {
          await axios.get(`${PETFINDER_API_URL}/${animal.id}`, {
            headers: { Authorization: `Bearer ${token}` },
          });
          await prisma.animalWithVideo.update({
            where: { id: animal.id },
            data: { lastSeenAt: new Date() },
          });
          totalRefreshed++;
        } catch (error) {
          if (error.response && error.response.status === 404) {
            console.log(
              `DEEP REFRESH: At-risk animal ID ${animal.id} is no longer active.`
            );
          } else {
            console.error(
              `DEEP REFRESH: Error re-validating at-risk animal ID ${animal.id}:`,
              error.message
            );
          }
        }
      }
      console.log(
        `DEEP REFRESH: Targeted re-validation refreshed ${totalRefreshed} records.`
      );
    } else {
      console.log("DEEP REFRESH: No at-risk animals found to re-validate.");
    }
  } catch (error) {
    console.error(
      `DEEP REFRESH: An error occurred during targeted re-validation:`,
      error.message
    );
  }

  const newTimestamp = startTime.toISOString();
  await redis.set(LAST_SCAN_TIMESTAMP_KEY, newTimestamp);
  console.log(
    `DEEP REFRESH: Daily refresh complete. Timestamp set to: ${newTimestamp}`
  );
};

// --- SCHEDULER & EXECUTION ---
console.log("Deep Refresh Worker started. Waiting for schedule.");

cron.schedule(
  "0 3 * * *",
  () => {
    console.log(
      `--- [${new Date().toLocaleString()}] Running Deep Refresh ---`
    );
    runDeepRefresh().catch((e) =>
      console.error("DEEP REFRESH: A fatal error occurred:", e)
    );
  },
  {
    scheduled: true,
    timezone: "America/Los_Angeles",
  }
);

// --- MANUAL EXECUTION ---
// runDeepRefresh()
//   .then(async () => {
//     console.log("DEEP REFRESH: Manual scan complete. Disconnecting.");
//     await prisma.$disconnect();
//     await redis.quit();
//   })
//   .catch(async (e) => {
//     console.error("DEEP REFRESH: A fatal error occurred:", e);
//     await prisma.$disconnect();
//     await redis.quit();
//     process.exit(1);
//   });
