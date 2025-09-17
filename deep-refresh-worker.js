/**
 * Pawadopt Deep Refresh Worker
 * ----------------------------
 * This script is a long-running service that runs once every 24 hours.
 * Its two jobs are:
 * 1. Prune stale data (animals > 24h old, orgs with no animals).
 * 2. Refresh the `lastSeenAt` timestamp of active animals to prevent them
 * from being pruned.
 *
 * How to run:
 * In development: node deep-refresh-worker.js
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
const LAST_SCAN_TIMESTAMP_KEY = "worker:last_scan_time";
const DEEP_REFRESH_PAGES = 3; // How many pages to scan for each hub to refresh timestamps

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

  for (const city of CITY_HUBS) {
    try {
      const coords = await getCityCoordinates(city);
      const locationString = `${coords.lat},${coords.lng}`;
      const token = await getValidToken();

      let totalRefreshedInHub = 0;

      // Scan the first few pages to "touch" recently active animals
      for (let page = 1; page <= DEEP_REFRESH_PAGES; page++) {
        const response = await axios.get(PETFINDER_API_URL, {
          headers: { Authorization: `Bearer ${token}` },
          params: {
            limit: PAGE_LIMIT,
            page: page,
            location: locationString,
            distance: SCAN_RADIUS_MILES,
            sort: "recent",
          },
        });

        const { animals } = response.data;
        if (!animals || animals.length === 0) {
          break; // No more animals on this page, stop scanning this hub
        }

        const animalIds = animals.map((a) => a.id);

        // "Touch" the records to update their `lastSeenAt` timestamp
        const { count } = await prisma.animalWithVideo.updateMany({
          where: { id: { in: animalIds } },
          data: { lastSeenAt: new Date() },
        });
        totalRefreshedInHub += count;
      }
      console.log(
        `DEEP REFRESH: Refreshed ${totalRefreshedInHub} records for hub: ${city}`
      );

      // --- END OF FIX ---
    } catch (error) {
      console.error(
        `DEEP REFRESH: Failed to refresh hub ${city}:`,
        error.message
      );
    }
  }
  const newTimestamp = startTime.toISOString();
  await redis.set(LAST_SCAN_TIMESTAMP_KEY, newTimestamp);
  console.log(
    `DEEP REFRESH: Daily refresh complete. Initial timestamp set to: ${newTimestamp}`
  );
  console.log("DEEP REFRESH: Daily refresh complete.");
};

// --- SCHEDULER ---
console.log("Deep Refresh Worker started. Waiting for schedule.");

// Schedule the worker to run once a day at 3:00 AM (server time)
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
// To run this script on-demand, comment out the cron.schedule block above
// and uncomment the block below.

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
