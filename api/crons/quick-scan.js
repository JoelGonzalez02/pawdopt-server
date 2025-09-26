// api/crons/quick-scan.js
import { PrismaClient } from "@prisma/client";
import Redis from "ioredis";
import axios from "axios";
import axiosRetry from "axios-retry";
import dotenv from "dotenv";
import querystring from "querystring";
import opencage from "opencage-api-client";
import { makeApiCallWithCount } from "../utils/apiTracker.js"; // Note: updated path for Vercel

// --- CONFIGURATION ---
dotenv.config();
const PETFINDER_API_URL = "https://api.petfinder.com/v2/animals";
const PAGE_LIMIT = 100;
const SCAN_RADIUS_MILES = 150;
const TARGET_PER_HUB = 5; // Safe, sustainable target per hub
const LAST_SCAN_TIMESTAMP_KEY = "worker:last_scan_time";
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
// Note: Vercel's serverless environment handles connections differently,
// so we don't need the connect/error listeners here.

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

const getValidToken = async () => {
  let token = await redis.get(PETFINDER_TOKEN_KEY);
  if (token) return token;

  const lockKey = `${PETFINDER_TOKEN_KEY}_lock`;
  if (await redis.set(lockKey, "1", "EX", 10, "NX")) {
    try {
      console.log("QUICK SCAN: No valid token, fetching new one...");
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

const getPlayableVideoUrl = (animal) => {
  if (!animal.videos?.length) return null;
  const match = animal.videos[0].embed?.match(/src="([^"]+)"/);
  const url = match ? match[1] : null;
  if (url && !/youtube|vimeo|facebook/.test(url)) {
    return url;
  }
  return null;
};

const getCityCoordinates = async (city) => {
  const cachedCoords = await redis.hget(CITY_COORDS_CACHE_KEY, city);
  if (cachedCoords) return JSON.parse(cachedCoords);
  console.log(`QUICK SCAN: Geocoding ${city}...`);
  const data = await opencage.geocode({
    q: city,
    key: process.env.OPENCAGE_API_KEY,
  });
  if (data.results?.length > 0) {
    const { lat, lng } = data.results[0].geometry;
    await redis.hset(CITY_COORDS_CACHE_KEY, city, JSON.stringify({ lat, lng }));
    return { lat, lng };
  }
  throw new Error(`Could not geocode ${city}`);
};

async function runQuickScan() {
  const startTime = new Date();
  console.log(`QUICK SCAN: [${startTime.toLocaleString()}] Starting scan...`);

  const lastScanTime = await redis.get(LAST_SCAN_TIMESTAMP_KEY);
  if (!lastScanTime) {
    console.log("QUICK SCAN: No last scan time. Run discovery-worker first.");
    return;
  }
  console.log(`QUICK SCAN: Scanning for animals added after: ${lastScanTime}`);

  for (const city of CITY_HUBS) {
    let newAnimalsFoundInHub = 0;
    try {
      const coords = await getCityCoordinates(city);
      let currentPage = 1;
      let hasMorePages = true;

      while (hasMorePages && newAnimalsFoundInHub < TARGET_PER_HUB) {
        const token = await getValidToken();
        const response = await makeApiCallWithCount(() =>
          axios.get(PETFINDER_API_URL, {
            headers: { Authorization: `Bearer ${token}` },
            params: {
              limit: PAGE_LIMIT,
              page: currentPage,
              location: `${coords.lat},${coords.lng}`,
              distance: SCAN_RADIUS_MILES,
              sort: "recent",
              after: lastScanTime,
            },
          })
        );

        const { animals, pagination } = response.data;
        if (!animals || animals.length === 0) {
          hasMorePages = false;
          continue;
        }

        const animalsWithVideo = animals.filter((animal) =>
          getPlayableVideoUrl(animal)
        );

        const uniqueOrgIds = [
          ...new Set(animalsWithVideo.map((a) => a.organization_id)),
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
              `QUICK SCAN: Failed to fetch/save org ${orgId}: ${orgError.message}`
            );
          }
        }

        for (const animal of animalsWithVideo) {
          if (newAnimalsFoundInHub >= TARGET_PER_HUB) break;
          try {
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
                city: animal.contact?.address?.city,
                state: animal.contact?.address?.state,
                latitude: coords.lat,
                longitude: coords.lng,
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
                city: animal.contact?.address?.city,
                state: animal.contact?.address?.state,
                latitude: coords.lat,
                longitude: coords.lng,
                likeCount: 0,
                organizationId: animal.organization_id,
              },
            });
            newAnimalsFoundInHub++;
          } catch (dbError) {
            console.error(
              `QUICK SCAN: Failed to save animal ${animal.id}: ${dbError.message}`
            );
          }
        }
        hasMorePages = pagination && currentPage < pagination.total_pages;
        currentPage++;
      }
      if (newAnimalsFoundInHub > 0) {
        console.log(
          `QUICK SCAN: [${city}] Found and saved ${newAnimalsFoundInHub} new animals.`
        );
      }
    } catch (error) {
      console.error(
        `QUICK SCAN: Failed to process hub ${city}:`,
        error.response?.data || error.message
      );
    }
  }

  await redis.set(LAST_SCAN_TIMESTAMP_KEY, startTime.toISOString());
  console.log(`QUICK SCAN: Scan for new animals complete.`);
}

// --- VERCEL SERVERLESS FUNCTION HANDLER ---
export default async function handler(req, res) {
  try {
    await runQuickScan();
    res.status(200).send("Quick Scan completed successfully.");
  } catch (error) {
    console.error(
      "QUICK SCAN: A fatal error occurred during the scheduled run:",
      error.message
    );
    res.status(500).send("Quick Scan failed.");
  }
}
