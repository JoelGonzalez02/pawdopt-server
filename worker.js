import axios from "axios";

const PETFINDER_API_URL = "https://api.petfinder.com/v2/animals";

// Helper to extract a URL from an embed string
const extractVideoUrl = (embed) => {
  const match = embed.match(/src="([^"]+)"/);
  return match ? match[1] : null;
};

// This is the main logic for our background job
// It now requires a location to be passed in.
export const buildReelsCache = async (redis, token, location) => {
  if (!location) {
    console.log("WORKER: Skipping job, no location provided.");
    return;
  }

  // Create a location-specific cache key (e.g., "reels:90210")
  const REELS_CACHE_KEY = `reels:${location}`;
  console.log(`WORKER: Starting job for location: ${location}`);

  let animalsForReels = [];
  let currentPage = 1;
  const maxPagesToFetch = 20; // Scan up to 2000 animals

  try {
    // We'll keep searching until we have a good number of videos or we hit our page limit
    while (animalsForReels.length < 50 && currentPage <= maxPagesToFetch) {
      const response = await axios.get(PETFINDER_API_URL, {
        headers: { Authorization: `Bearer ${token}` },
        params: {
          limit: 100,
          page: currentPage,
          location: location, // Use the location in the Petfinder API call
        },
      });

      const fetchedAnimals = response.data.animals;
      if (!fetchedAnimals || fetchedAnimals.length === 0) {
        console.log(
          `WORKER: No more animals found on Petfinder for location ${location}.`
        );
        break;
      }

      const filtered = fetchedAnimals.filter(
        (animal) =>
          animal.videos &&
          animal.videos.some((video) => {
            const url = extractVideoUrl(video.embed);
            return (
              url && !url.includes("youtube.com") && !url.includes("youtu.be")
            );
          })
      );

      if (filtered.length > 0) {
        animalsForReels = [...animalsForReels, ...filtered];
      }

      console.log(
        `WORKER: Scanned page ${currentPage} for ${location}, found ${filtered.length} video animals. Total so far: ${animalsForReels.length}`
      );
      currentPage++;
    }

    // Save the compiled, location-specific list to Redis
    await redis.set(
      REELS_CACHE_KEY,
      JSON.stringify({ animals: animalsForReels })
    );
    console.log(
      `WORKER: Successfully updated cache for ${location} with ${animalsForReels.length} animals.`
    );
  } catch (error) {
    console.error(
      `WORKER: Error building reels cache for ${location}:`,
      error.response?.data || error.message
    );
  }
};
