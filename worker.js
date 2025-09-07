import axios from "axios";

const PETFINDER_API_URL = "https://api.petfinder.com/v2/animals";
const REELS_CACHE_KEY = "reels:all_animals";

// Helper function to extract a non-YouTube video URL from Petfinder's embed code
const extractVideoUrl = (embed) => {
  const match = embed.match(/src="([^"]+)"/);
  const url = match ? match[1] : null;

  // Ensure the URL is valid and not a YouTube link
  if (url && !url.includes("youtube.com") && !url.includes("youtu.be")) {
    return url;
  }
  return null;
};

export const buildReelsCache = async (redis, token) => {
  console.log("WORKER: Starting job to find reel animals...");
  let animalsForReels = [];
  let currentPage = 1;
  const maxPagesToFetch = 20; // Limit how many pages we check to avoid long runs

  try {
    while (animalsForReels.length < 50 && currentPage <= maxPagesToFetch) {
      const response = await axios.get(PETFINDER_API_URL, {
        headers: { Authorization: `Bearer ${token}` },
        params: {
          limit: 100,
          page: currentPage,
          sort: "recent", // Get the newest animals
        },
      });

      const fetchedAnimals = response.data.animals;
      if (!fetchedAnimals || fetchedAnimals.length === 0) {
        console.log("WORKER: No more animals found on Petfinder API.");
        break; // Exit loop if there are no more results
      }

      // Filter for animals that have at least one valid, non-YouTube video
      const filtered = fetchedAnimals.filter(
        (animal) =>
          animal.videos &&
          animal.videos.some((video) => extractVideoUrl(video.embed))
      );

      animalsForReels.push(...filtered);
      currentPage++;
    }

    // Store the final list of animals in the Redis cache
    await redis.set(
      REELS_CACHE_KEY,
      JSON.stringify({ animals: animalsForReels })
    );
    console.log(
      `WORKER: Successfully updated Reels cache with ${animalsForReels.length} animals.`
    );
  } catch (error) {
    console.error(
      "WORKER: Error building reels cache:",
      error.response?.data || error.message
    );
  }
};
