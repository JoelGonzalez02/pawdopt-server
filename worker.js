// --- IMPORTS ---
import { PrismaClient } from "@prisma/client";
import Redis from "ioredis";
import axios from "axios";
import dotenv from "dotenv";
import querystring from "querystring";
import opencage from "opencage-api-client";

// --- CONFIGURATION ---
dotenv.config();
const PETFINDER_API_URL = "https://api.petfinder.com/v2/animals";
const PAGE_LIMIT = 100;
const SCAN_RADIUS_MILES = 150;
// This target is calibrated for an 8x-per-day run to stay under 1,000 API calls.
const TARGET_PER_HUB = 40;

const CITY_HUBS = [
  "Boston, MA",
  "New York, NY",
  "Philadelphia, PA",
  "Pittsburgh, PA",
  "Washington, DC",
  "Charlotte, NC",
  "Atlanta, GA",
  "Orlando, FL",
  "Miami, FL",
  "Nashville, TN",
  "Indianapolis, IN",
  "Detroit, MI",
  "Chicago, IL",
  "Minneapolis, MN",
  "St. Louis, MO",
  "Kansas City, MO",
  "Dallas, TX",
  "Houston, TX",
  "San Antonio, TX",
  "Denver, CO",
  "Salt Lake City, UT",
  "Phoenix, AZ",
  "Las Vegas, NV",
  "Seattle, WA",
  "Portland, OR",
  "Sacramento, CA",
  "San Francisco, CA",
  "Los Angeles, CA",
  "San Diego, CA",
];
const CITY_COORDS_CACHE_KEY = "worker:coords";

// --- INITIALIZATION ---
const prisma = new PrismaClient();
const redis = new Redis(process.env.REDIS_URL);
redis.on("error", (err) => console.error("WORKER: Redis Error", err));
redis.on("connect", () => console.log("WORKER: Connected to Redis."));

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
      "WORKER: Could not fetch Petfinder token.",
      error.response?.data || error.message
    );
    throw new Error("Could not authenticate with Petfinder.");
  }
};

// --- HELPER FUNCTIONS ---
const getPlayableVideoUrl = (animal) => {
  if (!animal.videos || animal.videos.length === 0 || !animal.videos[0].embed)
    return null;
  const match = animal.videos[0].embed.match(/src="([^"]+)"/);
  return match ? match[1] : null;
};

const getCityCoordinates = async (city) => {
  const cachedCoords = await redis.hget(CITY_COORDS_CACHE_KEY, city);
  if (cachedCoords) return JSON.parse(cachedCoords);

  console.log(`WORKER: Geocoding ${city}...`);
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
  console.log("WORKER: Pruning stale animal records...");
  const cutoffDate = new Date(Date.now() - 25 * 60 * 60 * 1000); // 25 hours ago
  const { count } = await prisma.animalWithVideo.deleteMany({
    where: { lastSeenAt: { lt: cutoffDate } },
  });
  console.log(`WORKER: Pruned ${count} stale records.`);
};

// --- MAIN WORKER ---
const runWorker = async () => {
  console.log("WORKER: Starting scheduled scan...");
  await pruneStaleAnimals();

  for (const city of CITY_HUBS) {
    let newAnimalsFoundInHub = 0;
    try {
      const coords = await getCityCoordinates(city);
      const locationString = `${coords.lat},${coords.lng}`;
      console.log(`WORKER: Scanning hub: ${city}`);

      let currentPage = 1;
      let hasMorePages = true;

      while (hasMorePages && newAnimalsFoundInHub < TARGET_PER_HUB) {
        const token = await getValidToken();
        const response = await axios.get(PETFINDER_API_URL, {
          headers: { Authorization: `Bearer ${token}` },
          params: {
            limit: PAGE_LIMIT,
            page: currentPage,
            location: locationString,
            distance: SCAN_RADIUS_MILES,
            sort: "recent",
          },
        });

        const { animals, pagination } = response.data;
        if (!animals || animals.length === 0) {
          hasMorePages = false;
          continue;
        }

        for (const animal of animals) {
          if (newAnimalsFoundInHub >= TARGET_PER_HUB) break;
          if (!getPlayableVideoUrl(animal)) continue;

          await prisma.animalWithVideo.upsert({
            where: { id: animal.id },
            update: {
              city: animal.contact.address.city,
              state: animal.contact.address.state,
              animalType: animal.type,
              rawJson: animal,
            },
            create: {
              id: animal.id,
              city: animal.contact.address.city,
              state: animal.contact.address.state,
              animalType: animal.type,
              rawJson: animal,
            },
          });
          newAnimalsFoundInHub++;
        }

        console.log(
          `WORKER: [${city}] Progress: ${newAnimalsFoundInHub}/${TARGET_PER_HUB} animals found.`
        );

        if (pagination && currentPage < pagination.total_pages) {
          currentPage++;
        } else {
          hasMorePages = false;
        }
      }
    } catch (error) {
      console.error(
        `WORKER: Failed to process hub ${city}:`,
        error.response?.data || error.message
      );
    }
  }
};

// --- EXECUTION ---
runWorker()
  .then(async () => {
    console.log("WORKER: Scan complete. Disconnecting.");
    await prisma.$disconnect();
    await redis.quit();
  })
  .catch(async (e) => {
    console.error("WORKER: A fatal error occurred:", e);
    await prisma.$disconnect();
    await redis.quit();
    process.exit(1);
  });
