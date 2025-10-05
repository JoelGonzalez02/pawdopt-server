import { Prisma, PrismaClient } from "@prisma/client";
import Redis from "ioredis";
import { randomUUID } from "crypto";
import opencage from "opencage-api-client";
import pino from "pino";

// --- INITIALIZATION ---
const prisma = new PrismaClient();
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
    logger.warn({ location }, "Geocoding failed to find results.");
    return null;
  }

  const { lat, lng } = geoData.results[0].geometry;
  const coords = { lat, lon: lng };

  await redis.set(cacheKey, JSON.stringify(coords), "EX", 60 * 60 * 24 * 30);
  return coords;
};

// --- VERCEL SERVERLESS FUNCTION HANDLER ---
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ message: "Method Not Allowed" });
  }

  const { location, page = 1, sessionId, userId } = req.body;
  const PAGE_SIZE = 10;

  if (!location && !sessionId) {
    return res
      .status(400)
      .json({ message: "Location or sessionId is required." });
  }

  try {
    if (sessionId) {
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
        return res.status(200).json({
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
      return res.status(200).json({
        animals: orderedAnimals,
        pagination: { currentPage: page, totalPages, sessionId },
      });
    }

    logger.info({ location, userId }, "Creating new tiered video session");
    const coords = await getUserCoordinates(location);

    if (!coords) {
      return res.status(200).json({
        animals: [],
        pagination: {
          currentPage: 1,
          totalPages: 0,
          sessionId: randomUUID(),
        },
      });
    }

    const userLat = coords.lat;
    const userLon = coords.lon;

    let user = await prisma.user.findUnique({ where: { uuid: userId } });
    if (!user) {
      user = await prisma.user.create({ data: { uuid: userId } });
    }

    const seenVideos = await prisma.seenVideo.findMany({
      where: { userId: user.id },
      select: { animalId: true },
    });
    const seenVideoIds = seenVideos.map((v) => v.animalId);

    const hyperLocalRadiusKm = 30 * 1.60934;
    const regionalRadiusKm = 100 * 1.60934;

    const hyperLocalAnimals = await prisma.$queryRaw`
        SELECT id FROM "AnimalWithVideo"
        WHERE (6371 * acos(LEAST(1.0, cos(radians(${userLat})) * cos(radians(latitude)) * cos(radians(longitude) - radians(${userLon})) + sin(radians(${userLat})) * sin(radians(latitude))))) < ${hyperLocalRadiusKm}
        ${
          seenVideoIds.length > 0
            ? Prisma.sql`AND id NOT IN (${Prisma.join(seenVideoIds)})`
            : Prisma.empty
        }
        ORDER BY (6371 * acos(LEAST(1.0, cos(radians(${userLat})) * cos(radians(latitude)) * cos(radians(longitude) - radians(${userLon})) + sin(radians(${userLat})) * sin(radians(latitude))))) ASC
        LIMIT 50;
    `;
    const hyperLocalIds = hyperLocalAnimals.map((c) => c.id);

    const seenAndHyperLocalIds = [...seenVideoIds, ...hyperLocalIds];
    const regionalAnimals = await prisma.$queryRaw`
        SELECT id FROM "AnimalWithVideo"
        WHERE (6371 * acos(LEAST(1.0, cos(radians(${userLat})) * cos(radians(latitude)) * cos(radians(longitude) - radians(${userLon})) + sin(radians(${userLat})) * sin(radians(latitude))))) < ${regionalRadiusKm}
        ${
          seenAndHyperLocalIds.length > 0
            ? Prisma.sql`AND id NOT IN (${Prisma.join(seenAndHyperLocalIds)})`
            : Prisma.empty
        }
        ORDER BY RANDOM()
        LIMIT 150;
    `;
    const regionalIds = regionalAnimals.map((c) => c.id);

    const allFoundIds = [...seenAndHyperLocalIds, ...regionalIds];
    const nationwideAnimals = await prisma.animalWithVideo.findMany({
      where: {
        id: { notIn: allFoundIds.length > 0 ? allFoundIds : undefined },
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
      return res.status(200).json({
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
    res.status(200).json({
      animals: orderedAnimals,
      pagination: { currentPage: 1, totalPages, sessionId: newSessionId },
    });
  } catch (error) {
    logger.error({ err: error, body: req.body }, "Error in /api/videos");
    res.status(500).json({ message: "Failed to fetch video feed." });
  }
}
