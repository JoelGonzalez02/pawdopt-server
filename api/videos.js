// api/videos.js

import { PrismaClient } from "@prisma/client";
import Redis from "ioredis";
import { randomUUID } from "crypto";
import opencage from "opencage-api-client";
import pino from "pino";

// --- INITIALIZATION ---
const prisma = new PrismaClient();
// FIX #1: Ensure Redis client has the correct TLS configuration for Vercel
const redis = new Redis(process.env.REDIS_URL, {
  tls: {
    rejectUnauthorized: false,
  },
});
const logger = pino({
  transport:
    process.env.NODE_ENV !== "production"
      ? { target: "pino-pretty" }
      : undefined,
});

redis.on("error", (err) => logger.error({ err }, "Redis Client Error"));

// --- HELPER FUNCTIONS ---
const getUserCoordinates = async (location) => {
  // ... (This function is unchanged)
};

// --- VERCEL SERVERLESS FUNCTION HANDLER ---
export default async function handler(req, res) {
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
    if (sessionId) {
      // ... (Pagination logic is unchanged)
      return res.status(200).json({
        animals: orderedAnimals,
        pagination: { currentPage: page, totalPages, sessionId },
      });
    }

    logger.info({ location }, "Creating new tiered video session");
    const coords = await getUserCoordinates(location);
    const userLat = coords.lat;
    const userLon = coords.lon;
    const searchRadiusKm = 150 * 1.60934;

    // FIX #2: Repeat the distance calculation in the ORDER BY clause
    const hyperLocalAnimals = await prisma.$queryRaw`
        SELECT id
        FROM "AnimalWithVideo"
        WHERE (6371 * acos(LEAST(1.0, cos(radians(${userLat})) * cos(radians(latitude)) * cos(radians(longitude) - radians(${userLon})) + sin(radians(${userLat})) * sin(radians(latitude))))) < ${searchRadiusKm}
        ORDER BY (6371 * acos(LEAST(1.0, cos(radians(${userLat})) * cos(radians(latitude)) * cos(radians(longitude) - radians(${userLon})) + sin(radians(${userLat})) * sin(radians(latitude))))) ASC
        LIMIT 50;
    `;
    const hyperLocalIds = hyperLocalAnimals.map((c) => c.id);

    const regionalAnimals = await prisma.$queryRaw`
        SELECT id FROM "AnimalWithVideo"
        WHERE (6371 * acos(LEAST(1.0, cos(radians(${userLat})) * cos(radians(latitude)) * cos(radians(longitude) - radians(${userLon})) + sin(radians(${userLat})) * sin(radians(latitude))))) < ${searchRadiusKm}
        AND id NOT IN (${
          hyperLocalIds.length > 0 ? Prisma.join(hyperLocalIds) : "NULL"
        })
        ORDER BY RANDOM()
        LIMIT 150;
    `;
    const regionalIds = regionalAnimals.map((c) => c.id);

    const allLocalIds = [...hyperLocalIds, ...regionalIds];
    const nationwideAnimals = await prisma.animalWithVideo.findMany({
      where: {
        id: { notIn: allLocalIds.length > 0 ? allLocalIds : undefined },
      },
      take: 200,
      select: { id: true },
    });
    let nationwideIds = nationwideAnimals.map((c) => c.id);
    for (let i = nationwideIds.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [nationwideIds[i], nationwideIds[j]] = [
        nationwideIds[j],
        nationwideIds[i],
      ];
    }

    const finalPlaylist = [...hyperLocalIds, ...regionalIds, ...nationwideIds];

    // ... (rest of the logic for creating the session and returning data is unchanged)
  } catch (error) {
    logger.error({ err: error, body: req.body }, "Error in /api/videos");
    res.status(500).json({ message: "Failed to fetch video feed." });
  }
}
