// janitor-worker.js
import { PrismaClient } from "@prisma/client";
import cron from "node-cron";
import dotenv from "dotenv";

dotenv.config();
const prisma = new PrismaClient();

const pruneStaleAnimals = async () => {
  const twentyFourHoursAgo = new Date(new Date() - 24 * 60 * 60 * 1000);
  console.log(
    `JANITOR: Pruning animals not seen since ${twentyFourHoursAgo.toISOString()}...`
  );

  try {
    const { count } = await prisma.animalWithVideo.deleteMany({
      where: {
        lastSeenAt: {
          lt: twentyFourHoursAgo,
        },
      },
    });

    if (count > 0) {
      console.log(
        `JANITOR: Successfully pruned ${count} stale animal records.`
      );
    } else {
      console.log("JANITOR: No stale records to prune.");
    }
  } catch (error) {
    console.error("JANITOR: Error during pruning process:", error);
  }
};

console.log("JANITOR: Worker started. Waiting for schedule (runs every hour).");

// Schedule the janitor to run at the top of every hour.
cron.schedule("0 * * * *", () => {
  pruneStaleAnimals();
});
