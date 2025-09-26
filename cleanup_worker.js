/**
 * Automated Cleanup Worker for Duplicate Animals
 * ----------------------------------------------
 * This script is a long-running service that runs once a day to find and
 * remove duplicate animals from the database, keeping only the earliest-added
 * record for each group (name, type, breed).
 *
 * How to run:
 * pm2 start cleanup-worker.js --name="cleanup"
 */

import { PrismaClient } from "@prisma/client";
import cron from "node-cron";

const prisma = new PrismaClient();

// Normalize breeds JSON to a stable string for comparison
function normalizeBreed(breeds) {
  if (!breeds) return "";
  try {
    // This handles the JSON object format from Prisma
    if (typeof breeds === "object" && !Array.isArray(breeds)) {
      return JSON.stringify(
        Object.entries(breeds)
          .map(([k, v]) => [k.toLowerCase(), String(v).toLowerCase()])
          .sort()
      );
    }
    return String(breeds).toLowerCase();
  } catch {
    return JSON.stringify(breeds);
  }
}

async function runCleanup() {
  console.log("CLEANUP: Starting daily cleanup of duplicate animals...");

  try {
    // Find groups of animals with the same name and type
    const groups = await prisma.animalWithVideo.groupBy({
      by: ["name", "type"],
      _count: { id: true },
    });

    const potentialDupes = groups.filter((g) => g._count.id > 1);

    if (potentialDupes.length === 0) {
      console.log("CLEANUP: No potential duplicates found. Database is clean!");
      return;
    }

    console.log(
      `CLEANUP: Found ${potentialDupes.length} groups of possible duplicates. Checking breeds...`
    );

    let totalDeleted = 0;

    for (const group of potentialDupes) {
      const records = await prisma.animalWithVideo.findMany({
        where: { name: group.name, type: group.type },
        select: { id: true, name: true, type: true, breeds: true },
      });

      // Group the records by their exact breed information
      const buckets = {};
      for (const record of records) {
        const key = normalizeBreed(record.breeds);
        if (!buckets[key]) buckets[key] = [];
        buckets[key].push(record);
      }

      // For any bucket with more than one animal, delete the extras
      for (const bucket of Object.values(buckets)) {
        if (bucket.length > 1) {
          // Sort by ID to determine which one to keep (the first one added)
          const sorted = bucket.sort((a, b) => a.id - b.id);
          const recordToKeep = sorted[0];
          const recordsToRemove = sorted.slice(1);
          const removeIds = recordsToRemove.map((r) => r.id);

          const { count } = await prisma.animalWithVideo.deleteMany({
            where: { id: { in: removeIds } },
          });

          console.log(
            `CLEANUP: Deleted ${count} duplicates for ${recordToKeep.name} (${recordToKeep.type}). Kept ID ${recordToKeep.id}.`
          );
          totalDeleted += count;
        }
      }
    }

    if (totalDeleted > 0) {
      console.log(
        `CLEANUP: Successfully deleted a total of ${totalDeleted} duplicate records.`
      );
    } else {
      console.log(
        "CLEANUP: No true duplicates (name+type+breed) found to delete."
      );
    }
  } catch (error) {
    console.error("CLEANUP: Error during duplicate cleanup:", error);
  }
}

// --- SCHEDULER ---
console.log("Cleanup Worker started. Waiting for schedule.");

// Schedule the worker to run once a day at 4:00 AM (server time)
cron.schedule(
  "0 * * * *",
  () => {
    console.log(
      `--- [${new Date().toLocaleString()}] Running Hourly Cleanup Task ---`
    );
    runCleanup().catch((e) => {
      console.error(
        "CLEANUP: A fatal error occurred during the scheduled run:",
        e
      );
    });
  },
  {
    scheduled: true,
    timezone: "America/Los_Angeles", // Set to your preferred timezone
  }
);
