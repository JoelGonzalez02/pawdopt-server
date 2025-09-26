// api/animal/[id].js

import { PrismaClient } from "@prisma/client";
import Redis from "ioredis";
import pino from "pino";

// --- INITIALIZATION ---
const prisma = new PrismaClient();
const redis = new Redis(process.env.REDIS_URL);
const logger = pino({
  transport:
    process.env.NODE_ENV !== "production"
      ? { target: "pino-pretty" }
      : undefined,
});

redis.on("error", (err) => logger.error({ err }, "Redis Client Error"));

// --- VERCEL SERVERLESS FUNCTION HANDLER ---
export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ message: "Method Not Allowed" });
  }

  // Vercel uses req.query for all URL parameters, including dynamic ones.
  const { id } = req.query; // Instead of req.params.id

  const animalId = parseInt(id);
  if (isNaN(animalId)) {
    return res.status(400).json({ message: "Invalid animal ID." });
  }

  const cacheKey = `animal:${animalId}`;
  try {
    // --- THIS IS THE EXACT SAME LOGIC FROM YOUR EXPRESS ROUTE ---
    const cachedAnimal = await redis.get(cacheKey);
    if (cachedAnimal) {
      res.setHeader("X-Cache", "HIT");
      return res.status(200).json(JSON.parse(cachedAnimal));
    }
    res.setHeader("X-Cache", "MISS");

    const animal = await prisma.animalWithVideo.findUnique({
      where: { id: animalId },
    });

    if (!animal) {
      return res
        .status(404)
        .json({ message: "Animal not found in our video database." });
    }

    await redis.set(cacheKey, JSON.stringify(animal), "EX", 21600); // Cache for 6 hours
    res.status(200).json(animal);
  } catch (error) {
    logger.error({ err: error, animalId: id }, "Error fetching single animal");
    res.status(500).json({ message: "An error occurred." });
  }
}
