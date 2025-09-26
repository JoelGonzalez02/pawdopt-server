// api/animal/[id]/like.js

import { PrismaClient } from "@prisma/client";
import pino from "pino";

// --- INITIALIZATION ---
const prisma = new PrismaClient();
const logger = pino({
  transport:
    process.env.NODE_ENV !== "production"
      ? { target: "pino-pretty" }
      : undefined,
});

// --- VERCEL SERVERLESS FUNCTION HANDLER ---
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ message: "Method Not Allowed" });
  }

  // Vercel puts all URL parameters in `req.query`
  const { id } = req.query;
  const { action } = req.body;

  const animalId = parseInt(id);

  // Validation logic (unchanged from Express)
  if (isNaN(animalId) || !["like", "unlike"].includes(action)) {
    return res.status(400).json({ message: "Invalid request." });
  }

  try {
    // --- THIS IS THE EXACT SAME LOGIC FROM YOUR EXPRESS ROUTE ---
    const updatedAnimal = await prisma.animalWithVideo.update({
      where: { id: animalId },
      data: {
        likeCount: action === "like" ? { increment: 1 } : { decrement: 1 },
      },
      select: { likeCount: true }, // Only select the field we need
    });

    res.status(200).json({ newLikeCount: updatedAnimal.likeCount });
  } catch (error) {
    logger.error(
      { err: error, animalId: id, action },
      "Error updating like count"
    );
    // Handle cases where the animal might not exist
    if (error.code === "P2025") {
      // Prisma code for "Record to update not found"
      return res.status(404).json({ message: "Animal not found." });
    }
    res.status(500).json({ message: "Could not update like count." });
  }
}
