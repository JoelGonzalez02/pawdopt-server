// api/videos.js

import { PrismaClient } from "@prisma/client";
import Redis from "ioredis";
import { randomUUID } from "crypto";
import opencage from "opencage-api-client";
import pino from "pino";

// --- INITIALIZATION (Moved from index.js) ---
const prisma = new PrismaClient();
const redis = new Redis(process.env.REDIS_URL);
const logger = pino({
  transport:
    process.env.NODE_ENV !== "production"
      ? { target: "pino-pretty" }
      : undefined,
});

redis.on("error", (err) => logger.error({ err }, "Redis Client Error"));

// --- HELPER FUNCTIONS (Copied from index.js) ---
const getUserCoordinates = async (location) => {
  const sanitizedLocation = location.toLowerCase().replace(/[^a-z0-9]/g, "");
  const cacheKey = `coords:${sanitizedLocation}`;

  const cachedCoords = await redis.get(cacheKey);
  if (cachedCoords) {
    logger.info({ location }, `Cache HIT for coordinates`);
    return JSON.parse(cachedCoords);
  }

  logger.info(
    { location },
    `Cache MISS for coordinates. Calling OpenCage API.`
  );
  const geoData = await opencage.geocode({
    q: location,
    key: process.env.OPENCAGE_API_KEY,
  });
  if (!geoData.results || geoData.results.length === 0) {
    throw new Error(`Could not determine coordinates for ${location}`);
  }

  const { lat, lng } = geoData.results[0].geometry;
  const coords = { lat, lon: lng };

  await redis.set(cacheKey, JSON.stringify(coords), "EX", 60 * 60 * 24 * 30);
  return coords;
};

// --- VERCEL SERVERLESS FUNCTION HANDLER ---
export default async function handler(req, res) {
  // Ensure we only handle POST requests
  if (req.method !== "POST") {
    return res.status(405).json({ message: "Method Not Allowed" });
  }

  const { location, page = 1, sessionId } = req.body;
  const PAGE_SIZE = 10;

  if (!location && !sessionId) {
    return res
      .status(400)
      .json({ message: "Location or sessionId is required." });
  }

  try {
    // --- THIS IS THE EXACT SAME LOGIC FROM YOUR EXPRESS ROUTE ---
    if (sessionId) {
      // Logic for paginating an existing session
      const sessionKey = `session:${sessionId}`;
      const animalIdsJson = await redis.get(sessionKey);
      if (!animalIdsJson) {
        return res
          .status(404)
          .json({ message: "Session expired. Please refresh." });
      }
      const animalIds = JSON.parse(animalIdsJson);
      const totalPages = Math.ceil(animalIds.length / PAGE_SIZE);
      const pageIds = animalIds.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

      if (pageIds.length === 0) {
        return res
          .status(200)
          .json({
            animals: [],
            pagination: { currentPage: page, totalPages, sessionId },
          });
      }

      const animalsData = await prisma.animalWithVideo.findMany({
        where: { id: { in: pageIds } },
        include: { organization: true },
      });

      const orderedAnimals = pageIds
        .map((id) => animalsData.find((a) => a.id === id))
        .filter(Boolean);
      return res
        .status(200)
        .json({
          animals: orderedAnimals,
          pagination: { currentPage: page, totalPages, sessionId },
        });
    }

    // Logic for creating a new session
    logger.info({ location }, "Creating new video session");
    const coords = await getUserCoordinates(location);
    const userLat = coords.lat;
    const userLon = coords.lon;
    const searchRadiusMiles = 150;

    const localCandidates = await prisma.$queryRaw`
        SELECT id FROM "AnimalWithVideo"
        WHERE latitude IS NOT NULL AND longitude IS NOT NULL AND
        (6371 * acos(LEAST(1.0, GREATEST(-1.0, cos(radians(${userLat})) * cos(radians(latitude)) * cos(radians(longitude) - radians(${userLon})) + sin(radians(${userLat})) * sin(radians(latitude)))))) < ${
      searchRadiusMiles * 1.60934
    }
        LIMIT 500;
    `;
    const localIds = localCandidates.map((c) => c.id);

    const nationwideCandidates = await prisma.animalWithVideo.findMany({
      take: 200,
      select: { id: true },
      where: { id: { notIn: localIds } },
    });
    const nationwideIds = nationwideCandidates.map((c) => c.id);

    // Shuffle both lists
    for (let i = localIds.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [localIds[i], localIds[j]] = [localIds[j], localIds[i]];
    }
    for (let i = nationwideIds.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [nationwideIds[i], nationwideIds[j]] = [
        nationwideIds[j],
        nationwideIds[i],
      ];
    }

    // Interleave the lists
    const finalPlaylist = [];
    let localIndex = 0;
    let nationwideIndex = 0;
    const localRatio = 3;
    while (
      localIndex < localIds.length ||
      nationwideIndex < nationwideIds.length
    ) {
      for (let i = 0; i < localRatio && localIndex < localIds.length; i++) {
        finalPlaylist.push(localIds[localIndex++]);
      }
      if (nationwideIndex < nationwideIds.length) {
        finalPlaylist.push(nationwideIds[nationwideIndex++]);
      }
    }

    const newSessionId = randomUUID();
    await redis.set(
      `session:${newSessionId}`,
      JSON.stringify(finalPlaylist),
      "EX",
      7200
    );

    const totalPages = Math.ceil(finalPlaylist.length / PAGE_SIZE);
    const pageIds = finalPlaylist.slice(0, PAGE_SIZE);

    if (pageIds.length === 0) {
      return res
        .status(200)
        .json({
          animals: [],
          pagination: { currentPage: 1, totalPages, sessionId: newSessionId },
        });
    }

    const pageData = await prisma.animalWithVideo.findMany({
      where: { id: { in: pageIds } },
      include: { organization: true },
    });

    const orderedAnimals = pageIds
      .map((id) => pageData.find((a) => a.id === id))
      .filter(Boolean);

    res
      .status(200)
      .json({
        animals: orderedAnimals,
        pagination: { currentPage: 1, totalPages, sessionId: newSessionId },
      });
  } catch (error) {
    logger.error({ err: error, body: req.body }, "Error in /api/videos");
    res.status(500).json({ message: "Failed to fetch video feed." });
  }
}
