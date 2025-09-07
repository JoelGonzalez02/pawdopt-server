import axios from "axios";

const PETFINDER_API_URL = "https://api.petfinder.com/v2/animals";
const REELS_CACHE_KEY = "reels:all_animals";

const extractVideoUrl = (embed) => {
  const match = embed.match(/src="([^"]+)"/);
  return match ? match[1] : null;
};

export const buildReelsCache = async (redis, token) => {
  console.log("WORKER: Starting job to find reel animals...");
  let animalsForReels = [];
  let currentPage = 1;
  const maxPagesToFetch = 20;

  try {
    while (animalsForReels.length < 50 && currentPage <= maxPagesToFetch) {
      const response = await axios.get(PETFINDER_API_URL, {
        headers: { Authorization: `Bearer ${token}` },
        params: { limit: 100, page: currentPage, sort: "recent" }, // No location
      });

      const fetchedAnimals = response.data.animals;
      if (!fetchedAnimals || fetchedAnimals.length === 0) {
        console.log("WORKER: No more animals found on Petfinder.");
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

      animalsForReels.push(...filtered);
      currentPage++;
    }

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
