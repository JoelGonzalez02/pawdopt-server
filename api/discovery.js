import { PrismaClient } from "@prisma/client";
import Redis from "ioredis";
import pino from "pino";
import { randomUUID } from "crypto";

// --- INITIALIZATION ---
// Best practice: instantiate clients outside the handler for connection reuse
const prisma = new PrismaClient();
const redis = new Redis(process.env.REDIS_URL);
const logger = pino({
  transport:
    process.env.NODE_ENV !== "production"
      ? { target: "pino-pretty" }
      : undefined,
});
const PAGE_SIZE = 12;

redis.on("error", (err) => logger.error({ err }, "Redis Client Error"));

// --- HELPER FUNCTION ---
// Moved into the same file to be self-contained
async function markAnimalsAsSeen(userId, animalIds) {
  if (!userId || !animalIds || animalIds.length === 0) return;

  try {
    const user = await prisma.user.findUnique({ where: { uuid: userId } });
    if (!user) return;

    const dataToInsert = animalIds.map((animalId) => ({
      userId: user.id,
      animalId: animalId,
    }));

    await prisma.seenAnimal.createMany({
      data: dataToInsert,
      skipDuplicates: true,
    });
    logger.info(
      `Marked ${animalIds.length} animals as seen for user ${userId}`
    );
  } catch (error) {
    logger.error(
      { err: error },
      "Background job: Failed to mark animals as seen."
    );
  }
}

// --- VERCEL SERVERLESS HANDLER ---
export default async function handler(req, res) {
  // Handle preflight OPTIONS request for CORS
  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  // Ensure the request is a POST
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).json({ message: "Method Not Allowed" });
  }

  const { filters, sessionId, page = 1, userId } = req.body;

  try {
    // --- SCENARIO 1: PAGINATING AN EXISTING SESSION ---
    if (sessionId) {
      const sessionKey = `discovery-session:${sessionId}`;
      const animalIdsJson = await redis.get(sessionKey);

      if (!animalIdsJson) {
        return res
          .status(404)
          .json({ message: "Session expired or not found." });
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

      // Mark animals as seen in the background (no need to 'await')
      markAnimalsAsSeen(userId, pageIds);

      return res.status(200).json({
        animals: animalsData,
        pagination: { currentPage: page, totalPages, sessionId },
      });
    }

    // --- SCENARIO 2: CREATING A NEW DISCOVERY SESSION ---
    if (!filters || !userId) {
      return res.status(400).json({
        message: "Filters and userId are required to create a new session.",
      });
    }

    let user = await prisma.user.findUnique({ where: { uuid: userId } });
    if (!user) {
      user = await prisma.user.create({ data: { uuid: userId } });
    }

    const seenAnimals = await prisma.seenAnimal.findMany({
      where: { userId: user.id },
      select: { animalId: true },
    });

    const excludedIds = seenAnimals.map((a) => a.animalId);

    const queryOptions = {
      where: {
        id: { notIn: excludedIds.length > 0 ? excludedIds : undefined },
        type: filters.type,
        age: filters.age,
        gender: filters.gender,
      },
      select: { id: true },
    };

    const allEligibleAnimals = await prisma.animalWithVideo.findMany(
      queryOptions
    );
    let allEligibleIds = allEligibleAnimals.map((a) => a.id);

    // Shuffle for randomness
    for (let i = allEligibleIds.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [allEligibleIds[i], allEligibleIds[j]] = [
        allEligibleIds[j],
        allEligibleIds[i],
      ];
    }

    const newSessionId = randomUUID();
    await redis.set(
      `discovery-session:${newSessionId}`,
      JSON.stringify(allEligibleIds),
      "EX",
      3600 // 1 hour expiry
    );

    const totalPages = Math.ceil(allEligibleIds.length / PAGE_SIZE);
    const firstPageIds = allEligibleIds.slice(0, PAGE_SIZE);

    if (firstPageIds.length === 0) {
      return res.status(200).json({
        animals: [],
        pagination: { currentPage: 1, totalPages: 0, sessionId: newSessionId },
      });
    }

    const animalsData = await prisma.animalWithVideo.findMany({
      where: { id: { in: firstPageIds } },
      include: { organization: true },
    });

    markAnimalsAsSeen(userId, firstPageIds);

    res.status(200).json({
      animals: animalsData,
      pagination: { currentPage: 1, totalPages, sessionId: newSessionId },
    });
  } catch (error) {
    logger.error({ err: error, body: req.body }, "Error in /api/discovery");
    res.status(500).json({ message: "Failed to fetch discovery animals." });
  }
}
