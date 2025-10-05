// api/seen.js
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

  // Expect a userId (as UUID string) and an array of animalIds
  const { userId, animalIds } = req.body;

  // Validate the incoming data
  if (!userId || !Array.isArray(animalIds) || animalIds.length === 0) {
    return res.status(400).json({
      message: "userId and a non-empty animalIds array are required.",
    });
  }

  try {
    // Find or create the user based on their UUID
    let user = await prisma.user.findUnique({
      where: { uuid: userId },
    });

    if (!user) {
      user = await prisma.user.create({
        data: { uuid: userId },
      });
    }

    // Prepare the data for a bulk insert into the seenVideo table
    const dataToInsert = animalIds.map((animalId) => ({
      userId: user.id, // Use the integer ID from the database user record
      animalId: animalId,
    }));

    // Use `createMany` to insert all records in a single, efficient database call.
    // `skipDuplicates` will silently ignore any records that already exist.
    const { count } = await prisma.seenVideo.createMany({
      data: dataToInsert,
      skipDuplicates: true,
    });

    console.log(
      `Successfully saved ${count} new seen video records for user ${user.id}.`
    );
    res.status(200).json({ success: true, count });
  } catch (error) {
    logger.error({ err: error, body: req.body }, "Error saving seen videos");
    res.status(500).json({ message: "Could not save seen videos." });
  }
}
