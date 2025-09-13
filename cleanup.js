/**
 * Cleanup Script for Invalid Video URLs
 * --------------------------------------
 * This script finds and removes records from the AnimalWithVideo table
 * that contain video URLs from unwanted sources (Vimeo, Facebook).
 *
 * It operates in two stages:
 * 1. Dry Run: It first shows you what will be deleted without changing anything.
 * 2. Deletion: You must uncomment a block of code to perform the actual deletion.
 *
 * How to run:
 * node cleanup.js
 */

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// Helper function to extract the video URL from the rawJson
const getVideoUrlFromJson = (rawJson) => {
  if (
    !rawJson ||
    !rawJson.videos ||
    !Array.isArray(rawJson.videos) ||
    rawJson.videos.length === 0
  ) {
    return "No Video Found";
  }
  const embed = rawJson.videos[0].embed;
  if (!embed || typeof embed !== "string") return "Invalid Embed";
  const match = embed.match(/src="([^"]+)"/);
  return match ? match[1] : "URL Not Found";
};

async function cleanupBadUrls() {
  console.log("Starting cleanup of invalid video URLs (Vimeo, Facebook)...");

  try {
    // This condition searches inside the rawJson field for the unwanted URLs
    const deleteCondition = {
      OR: [
        {
          rawJson: {
            path: ["videos", "0", "embed"], // The path to the string we want to check
            string_contains: "vimeo.com",
          },
        },
        {
          rawJson: {
            path: ["videos", "0", "embed"],
            string_contains: "facebook.com",
          },
        },
      ],
    };

    // --- Step 1: Find records to be deleted (Dry Run) ---
    console.log("\n--- DRY RUN ---");
    const recordsToDelete = await prisma.animalWithVideo.findMany({
      where: deleteCondition,
      select: { id: true, rawJson: true },
    });

    if (recordsToDelete.length === 0) {
      console.log(
        "✅ No records with Vimeo or Facebook URLs found. Database is clean!"
      );
      return;
    }

    // Format the results for clean logging
    const formattedRecords = recordsToDelete.map((record) => ({
      id: record.id,
      name: record.rawJson.name,
      videoUrl: getVideoUrlFromJson(record.rawJson),
    }));

    console.log(
      `Found ${formattedRecords.length} records to delete. Examples:`
    );
    console.table(formattedRecords.slice(0, 10)); // Show up to 10 examples
    console.log(
      "\nTo permanently delete these records, edit this script and uncomment the 'DELETING RECORDS' block."
    );

    // --- Step 2: Uncomment this block to permanently delete the records ---
    /*
    console.log("\n--- DELETING RECORDS ---");
    const deleteResult = await prisma.animalWithVideo.deleteMany({
      where: deleteCondition,
    });
    console.log(`✅ Successfully deleted ${deleteResult.count} records.`);
    */
  } catch (error) {
    console.error("❌ Error during cleanup:", error);
  } finally {
    await prisma.$disconnect();
    console.log("\nCleanup script finished.");
  }
}

cleanupBadUrls();
