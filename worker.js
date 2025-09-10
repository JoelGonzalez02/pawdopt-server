// worker.js

import axios from "axios";

const PETFINDER_API_URL = "https://api.petfinder.com/v2/animals";

// Helper function to add a delay
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Helper function to extract a non-YouTube video URL
const extractVideoUrl = (embed) => {
  const match = embed.match(/src="([^"]+)"/);
  const url = match ? match[1] : null;
  if (url && !url.includes("youtube.com") && !url.includes("youtu.be")) {
    return url;
  }
  return null;
};

// Internal helper function to fetch and filter animals that have videos
const fetchAnimalsWithVideos = async (token, params, fetchLimit) => {
  let animalsForReels = [];
  let currentPage = 1;
  const { pages: maxPagesToFetch, count: targetAnimalCount } = fetchLimit;

  while (
    animalsForReels.length < targetAnimalCount &&
    currentPage <= maxPagesToFetch
  ) {
    try {
      const response = await axios.get(PETFINDER_API_URL, {
        headers: { Authorization: `Bearer ${token}` },
        params: { limit: 100, page: currentPage, ...params },
      });

      const fetchedAnimals = response.data.animals;
      if (!fetchedAnimals || fetchedAnimals.length === 0) {
        break; // No more results from the API
      }

      const filtered = fetchedAnimals.filter(
        (animal) =>
          animal.videos &&
          animal.videos.some((video) => extractVideoUrl(video.embed))
      );

      if (filtered.length > 0) {
        animalsForReels.push(...filtered);
      }

      await sleep(250); // Pace requests
      currentPage++;
    } catch (error) {
      // Handle 429 Rate Limit error specifically if needed, otherwise break
      if (error.response && error.response.status === 429) {
        console.warn("RATE LIMIT: Hit rate limit, pausing fetch loop.");
        await sleep(5000); // Wait 5 seconds before trying next page
      } else {
        console.error("WORKER: Error fetching page:", error.message);
        break; // Exit loop on other errors
      }
    }
  }
  return animalsForReels;
};

// The primary worker function that builds a "Feed Unit" based on a context
export const buildFeedUnit = async (redis, token, options) => {
  const { context, location, distance, type } = options;
  const cacheKey = `feed:${context}:${location}:${distance}:${type || "all"}`;
  let feedAnimals = [];

  console.log(
    `WORKER: Building Feed Unit for context: ${context}, Location: ${location}, Type: ${
      type || "All"
    }`
  );

  if (context === "forYou") {
    const primaryParams = {
      location,
      distance,
      sort: "distance",
      type: type || undefined,
    };
    const randomParams = { sort: "random", type: type || undefined };

    // Fetch a large base of relevant, local animals
    const primaryAnimals = await fetchAnimalsWithVideos(token, primaryParams, {
      pages: 40,
      count: 80,
    });
    // Fetch a smaller, random batch for variety
    const randomAnimals = await fetchAnimalsWithVideos(token, randomParams, {
      pages: 10,
      count: 20,
    });

    const primaryIds = new Set(primaryAnimals.map((a) => a.id));
    const uniqueRandom = randomAnimals.filter((a) => !primaryIds.has(a.id));

    feedAnimals = [...primaryAnimals, ...uniqueRandom];

    // Shuffle the final blended feed
    for (let i = feedAnimals.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [feedAnimals[i], feedAnimals[j]] = [feedAnimals[j], feedAnimals[i]];
    }
  }

  await redis.set(
    cacheKey,
    JSON.stringify({ animals: feedAnimals }),
    "EX",
    3600
  ); // Cache for 1 hour
  console.log(
    `WORKER: Cached ${feedAnimals.length} animals for key: ${cacheKey}`
  );
};
