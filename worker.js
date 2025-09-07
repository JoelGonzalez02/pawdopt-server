import axios from "axios";

const PETFINDER_API_URL = "https://api.petfinder.com/v2/animals";

const extractVideoUrl = (embed) => {
  const match = embed.match(/src="([^"]+)"/);
  return match ? match[1] : null;
};

export const buildReelsCache = async (redis, token, location) => {
  if (!location) {
    console.log("WORKER: Skipping job, no location provided.");
    return;
  }

  const REELS_CACHE_KEY = `reels:${location}`;
  console.log(`WORKER: Starting job for location: ${location}`);

  let animalsForReels = [];
  let currentPage = 1;
  const maxPagesToFetch = 20;

  try {
    while (animalsForReels.length < 50 && currentPage <= maxPagesToFetch) {
      const response = await axios.get(PETFINDER_API_URL, {
        headers: { Authorization: `Bearer ${token}` },
        params: {
          limit: 100,
          page: currentPage,
          location: location,
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
