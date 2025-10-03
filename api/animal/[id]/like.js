import { PrismaClient } from "@prisma/client";
import pino from "pino";

const prisma = new PrismaClient();
const logger = pino({
  transport:
    process.env.NODE_ENV !== "production"
      ? { target: "pino-pretty" }
      : undefined,
});

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ message: "Method Not Allowed" });
  }

  const { id } = req.query;
  const { action } = req.body;

  const animalId = parseInt(id);

  if (isNaN(animalId) || !["like", "unlike"].includes(action)) {
    return res.status(400).json({ message: "Invalid request." });
  }

  try {
    const updatedAnimal = await prisma.animalWithVideo.update({
      where: { id: animalId },
      data: {
        likeCount: action === "like" ? { increment: 1 } : { decrement: 1 },
      },
      select: { likeCount: true },
    });

    res.status(200).json({ newLikeCount: updatedAnimal.likeCount });
  } catch (error) {
    logger.error(
      { err: error, animalId: id, action },
      "Error updating like count"
    );
    if (error.code === "P2025") {
      return res.status(404).json({ message: "Animal not found." });
    }
    res.status(500).json({ message: "Could not update like count." });
  }
}
