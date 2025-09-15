/**
 * Cleanup Script for YouTube Video URLs
 * --------------------------------------
 * This script finds and removes records from the AnimalWithVideo table
 * that contain non-playable YouTube iframe videos.
 *
 * How to run:
 * node cleanup-youtube.js
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

async function cleanupYoutubeUrls() {
  console.log("Starting cleanup of YouTube video URLs...");

  try {
    // This condition specifically targets records with "youtube.com" in the video embed code
    const deleteCondition = {
      rawJson: {
        path: ["videos", "0", "embed"],
        string_contains: "youtube.com",
      },
    };

    // --- Step 1: Find records to be deleted (Dry Run) ---
    // console.log("\n--- DRY RUN ---");
    // const recordsToDelete = await prisma.animalWithVideo.findMany({
    //   where: deleteCondition,
    //   select: { id: true, rawJson: true },
    // });

    // if (recordsToDelete.length === 0) {
    //   console.log("✅ No records with YouTube URLs found. Database is clean!");
    //   return;
    // }

    // // Format the results for a clean table view
    // const formattedRecords = recordsToDelete.map((record) => ({
    //   id: record.id,
    //   name: record.rawJson.name,
    //   videoUrl: getVideoUrlFromJson(record.rawJson),
    // }));

    // console.log(
    //   `Found ${formattedRecords.length} records to delete. Examples:`
    // );
    // console.table(formattedRecords.slice(0, 10)); // Show up to 10 examples
    // console.log(
    //   "\nTo permanently delete these records, edit this script and uncomment the 'DELETING RECORDS' block."
    // );

    // --- Step 2: Uncomment this block to permanently delete the records ---

    console.log("\n--- DELETING RECORDS ---");
    const deleteResult = await prisma.animalWithVideo.deleteMany({
      where: deleteCondition,
    });
    console.log(`✅ Successfully deleted ${deleteResult.count} records.`);
  } catch (error) {
    console.error("❌ Error during cleanup:", error);
  } finally {
    await prisma.$disconnect();
    console.log("\nCleanup script finished.");
  }
}

cleanupYoutubeUrls();
