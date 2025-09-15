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
const TARGET_PER_HUB = 40;

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
  if (
    !animal.videos ||
    !Array.isArray(animal.videos) ||
    animal.videos.length === 0
  )
    return null;
  const embed = animal.videos[0].embed;
  if (!embed || typeof embed !== "string") return null;
  const match = embed.match(/src="([^"]+)"/);
  const url = match ? match[1] : null;
  if (!url) return null;
  const isBlocked =
    url.includes("youtube.com") ||
    url.includes("vimeo.com") ||
    url.includes("facebook.com");
  return isBlocked ? null : url;
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
  const cutoffDate = new Date(Date.now() - 25 * 60 * 60 * 1000);
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

          let latitude = null;
          let longitude = null;
          const address = animal.contact.address;

          try {
            if (address && address.city && address.state) {
              const fullAddress = `${address.address1 || ""}, ${
                address.city
              }, ${address.state} ${address.postcode || ""}`;
              const geoData = await opencage.geocode({
                q: fullAddress,
                key: process.env.OPENCAGE_API_KEY,
              });
              if (geoData.results.length > 0) {
                latitude = geoData.results[0].geometry.lat;
                longitude = geoData.results[0].geometry.lng;
              }
            }
          } catch (geoError) {
            console.error(
              `WORKER: Could not geocode address for animal ${animal.id}: ${geoError.message}`
            );
          }

          // --- CORRECTED DATA MAPPING TO MATCH OPTIMIZED SCHEMA ---
          await prisma.animalWithVideo.upsert({
            where: { id: animal.id },
            update: {
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
              attributes: animal.attributes, // <-- Add this line
              environment: animal.environment,
              city: animal.contact.address.city,
              state: animal.contact.address.state,
              latitude: latitude,
              longitude: longitude,
            },
            create: {
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
              attributes: animal.attributes, // <-- Add this line
              environment: animal.environment,
              city: animal.contact.address.city,
              state: animal.contact.address.state,
              latitude: latitude,
              longitude: longitude,
              likeCount: 0, // Set initial like count for new animals
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
