/**
 * Pawadopt Population Worker
 * --------------------------
 * This is a one-time script to perform the initial, large-scale population
 * of an empty database. It finds a large number of animals with videos,
 * fetches their details, and sets the initial timestamp for the
 * automated quick-scan worker to take over.
 *
 * How to run:
 * node populate-worker.js
 */

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
const TARGET_PER_HUB = 100; // High target for a deep, initial scan
const LAST_SCAN_TIMESTAMP_KEY = "worker:last_scan_time";

const CITY_HUBS = [
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
redis.on("error", (err) => console.error("POPULATE WORKER: Redis Error", err));
redis.on("connect", () => console.log("POPULATE WORKER: Connected to Redis."));

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
      "POPULATE WORKER: Could not fetch Petfinder token.",
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
  console.log(`POPULATE WORKER: Geocoding ${city}...`);
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

// --- MAIN WORKER ---
const runPopulationScan = async () => {
  const startTime = new Date();
  console.log(
    `POPULATE WORKER: [${startTime.toLocaleString()}] Starting database population scan...`
  );

  for (const city of CITY_HUBS) {
    let newAnimalsFoundInHub = 0;
    try {
      const coords = await getCityCoordinates(city);
      const locationString = `${coords.lat},${coords.lng}`;
      console.log(`POPULATE WORKER: Scanning hub: ${city}`);

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

          try {
            const orgId = animal.organization_id;
            const orgResponse = await axios.get(
              `https://api.petfinder.com/v2/organizations/${orgId}`,
              {
                headers: { Authorization: `Bearer ${token}` },
              }
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
              `POPULATE WORKER: Failed to fetch/save organization ${animal.organization_id}`,
              orgError.message
            );
            continue;
          }

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
              `POPULATE WORKER: Could not geocode address for animal ${animal.id}: ${geoError.message}`
            );
          }

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
              attributes: animal.attributes,
              environment: animal.environment,
              city: animal.contact.address.city,
              state: animal.contact.address.state,
              latitude: latitude,
              longitude: longitude,
              organizationId: animal.organization_id,
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
              attributes: animal.attributes,
              environment: animal.environment,
              city: animal.contact.address.city,
              state: animal.contact.address.state,
              latitude: latitude,
              longitude: longitude,
              likeCount: 0,
              organizationId: animal.organization_id,
            },
          });
          newAnimalsFoundInHub++;
        }

        console.log(
          `POPULATE WORKER: [${city}] Progress: ${newAnimalsFoundInHub}/${TARGET_PER_HUB} animals found.`
        );
        if (pagination && currentPage < pagination.total_pages) {
          currentPage++;
        } else {
          hasMorePages = false;
        }
      }
    } catch (error) {
      console.error(
        `POPULATE WORKER: Failed to process hub ${city}:`,
        error.response?.data || error.message
      );
    }
  }

  const newTimestamp = startTime.toISOString();
  await redis.set(LAST_SCAN_TIMESTAMP_KEY, newTimestamp);
  console.log(
    `POPULATE WORKER: Population scan complete. Initial timestamp set to: ${newTimestamp}`
  );
};

// --- EXECUTION ---
runPopulationScan()
  .then(async () => {
    console.log("POPULATE WORKER: Disconnecting.");
    await prisma.$disconnect();
    await redis.quit();
  })
  .catch(async (e) => {
    console.error("POPULATE WORKER: A fatal error occurred:", e);
    await prisma.$disconnect();
    await redis.quit();
    process.exit(1);
  });
