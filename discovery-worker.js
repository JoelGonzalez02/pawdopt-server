// discovery-worker.js
import { PrismaClient } from "@prisma/client";
import Redis from "ioredis";
import axios from "axios";
import axiosRetry from "axios-retry";
import dotenv from "dotenv";
import querystring from "querystring";
import opencage from "opencage-api-client";
import cron from "node-cron";
import { makeApiCallWithCount } from "./utils/apiTracker.js";

// --- CONFIGURATION ---
dotenv.config();
const PETFINDER_API_URL = "https://api.petfinder.com/v2/animals";
const PAGE_LIMIT = 100;
const SCAN_RADIUS_MILES = 150;
const PETFINDER_TOKEN_KEY = "petfinder_token";
const CITY_COORDS_CACHE_KEY = "worker:coords";

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

// --- INITIALIZATION ---
const prisma = new PrismaClient();
const redis = new Redis(process.env.REDIS_URL);
redis.on("error", (err) => console.error("DISCOVERY WORKER: Redis Error", err));
redis.on("connect", () => console.log("DISCOVERY WORKER: Connected to Redis."));

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

const getValidToken = async () => {
  let token = await redis.get(PETFINDER_TOKEN_KEY);
  if (token) return token;

  const lockKey = `${PETFINDER_TOKEN_KEY}_lock`;
  const lock = await redis.set(lockKey, "1", "EX", 10, "NX");

  if (!lock) {
    await delay(2000);
    return getValidToken();
  }

  try {
    token = await redis.get(PETFINDER_TOKEN_KEY);
    if (token) return token;

    console.log("DISCOVERY WORKER: No valid token, fetching new one...");
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
};

const getPlayableVideoUrl = (animal) => {
  if (
    !animal.videos ||
    !Array.isArray(animal.videos) ||
    animal.videos.length === 0
  )
    return null;
  const embed = animal.videos[0].embed;
  if (!embed || typeof embed !== "string") return null;
  const match = embed.match(/src="([^"]+)"/);
  return match ? match[1] : null;
};

const getCityCoordinates = async (city) => {
  const cachedCoords = await redis.hget(CITY_COORDS_CACHE_KEY, city);
  if (cachedCoords) {
    return JSON.parse(cachedCoords);
  }
  console.log(`DISCOVERY WORKER: Geocoding ${city}...`);
  try {
    const data = await opencage.geocode({
      q: city,
      key: process.env.OPENCAGE_API_KEY,
      limit: 1,
    });
    if (data.results?.length > 0) {
      const { lat, lng } = data.results[0].geometry;
      const coords = { lat, lng };
      await redis.hset(CITY_COORDS_CACHE_KEY, city, JSON.stringify(coords));
      return coords;
    }
  } catch (error) {
    console.error(
      `DISCOVERY WORKER: Could not geocode ${city}:`,
      error.message
    );
  }
  throw new Error(`Could not geocode ${city}`);
};

// --- MAIN PROCESSING LOGIC ---
const runDiscoveryScan = async () => {
  console.log(
    `DISCOVERY WORKER: [${new Date().toLocaleString()}] Starting daily discovery scan...`
  );

  for (const city of CITY_HUBS) {
    let animalsAddedInHub = 0;
    try {
      const coords = await getCityCoordinates(city);
      const token = await getValidToken();

      const response = await makeApiCallWithCount(() =>
        axios.get(PETFINDER_API_URL, {
          headers: { Authorization: `Bearer ${token}` },
          params: {
            limit: PAGE_LIMIT,
            location: `${coords.lat},${coords.lng}`,
            distance: SCAN_RADIUS_MILES,
            sort: "distance",
          },
        })
      );

      const { animals } = response.data;
      if (!animals || animals.length === 0) {
        console.log(`DISCOVERY WORKER: No animals found for city ${city}.`);
        continue;
      }

      const newAnimalsWithVideo = animals.filter((animal) =>
        getPlayableVideoUrl(animal)
      );
      if (newAnimalsWithVideo.length === 0) continue;

      const uniqueOrgIds = [
        ...new Set(newAnimalsWithVideo.map((a) => a.organization_id)),
      ];
      for (const orgId of uniqueOrgIds) {
        try {
          const orgResponse = await makeApiCallWithCount(() =>
            axios.get(`https://api.petfinder.com/v2/organizations/${orgId}`, {
              headers: { Authorization: `Bearer ${token}` },
            })
          );
          const orgData = orgResponse.data.organization;
          await prisma.organization.upsert({
            where: { id: orgId },
            update: {
              name: orgData.name,
              email: orgData.email,
              phone: orgData.phone,
              address: orgData.address,
              url: orgData.url,
            },
            create: {
              id: orgId,
              name: orgData.name,
              email: orgData.email,
              phone: orgData.phone,
              address: orgData.address,
              url: orgData.url,
            },
          });
        } catch (orgError) {
          console.error(
            `DISCOVERY WORKER: Failed to fetch/save organization ${orgId}`,
            orgError.message
          );
        }
      }

      for (const animal of newAnimalsWithVideo) {
        const existingAnimal = await prisma.animalWithVideo.findUnique({
          where: { id: animal.id },
        });
        if (existingAnimal) continue;

        try {
          await prisma.animalWithVideo.create({
            data: {
              id: animal.id,
              name: animal.name,
              url: animal.url,
              type: animal.type,
              age: animal.age,
              gender: animal.gender,
              size: animal.size,
              status: animal.status,
              breeds: animal.breeds,
              colors: animal.colors,
              photos: animal.photos,
              videos: animal.videos,
              contact: animal.contact,
              attributes: animal.attributes,
              environment: animal.environment,
              city: animal.contact?.address?.city,
              state: animal.contact?.address?.state,
              latitude: coords.lat,
              longitude: coords.lng,
              likeCount: 0,
              organizationId: animal.organization_id,
            },
          });
          animalsAddedInHub++;
        } catch (dbError) {
          console.error(
            `DISCOVERY WORKER: Failed to save animal ${animal.id}. Error: ${dbError.message}`
          );
        }
      }

      if (animalsAddedInHub > 0) {
        console.log(
          `DISCOVERY WORKER: [${city}] Finished processing. Added ${animalsAddedInHub} new animals.`
        );
      }
    } catch (error) {
      console.error(
        `DISCOVERY WORKER: Failed to process hub ${city}:`,
        error.response?.data || error.message
      );
    }
  }
  console.log("DISCOVERY WORKER: Daily discovery scan complete.");
};

// --- SCHEDULER ---
console.log("Discovery Worker started. Waiting for schedule.");
cron.schedule("0 2 * * *", () => {
  runDiscoveryScan().catch((e) =>
    console.error(
      "DISCOVERY WORKER: A fatal error occurred during the scheduled run:",
      e
    )
  );
});
