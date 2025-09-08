// worker.js

import axios from "axios";

const PETFINDER_API_URL = "https://api.petfinder.com/v2/animals";
const REELS_CACHE_KEY = "reels:all_animals"; // For the "All" tab
const LOCATION_REELS_CACHE_PREFIX = "reels:location:"; // For the "For You" tab

// Helper function to extract a non-YouTube video URL
const extractVideoUrl = (embed) => {
  const match = embed.match(/src="([^"]+)"/);
  const url = match ? match[1] : null;
  if (url && !url.includes("youtube.com") && !url.includes("youtu.be")) {
    return url;
  }
  return null;
};

/**
 * A generic function to fetch and filter animals with videos from Petfinder.
 * @param {string} token - The Petfinder API token.
 * @param {object} params - The query parameters for the Petfinder API (e.g., location).
 * @returns {Promise<Array>} - A promise that resolves to an array of animal objects.
 */
const fetchAndFilterAnimals = async (token, params) => {
  let animalsForReels = [];
  let currentPage = 1;
  const maxPagesToFetch = 10; // Reduced pages for faster on-demand fetching

  while (animalsForReels.length < 50 && currentPage <= maxPagesToFetch) {
    const response = await axios.get(PETFINDER_API_URL, {
      headers: { Authorization: `Bearer ${token}` },
      params: {
        limit: 100,
        page: currentPage,
        sort: "recent",
        ...params, // Spread the incoming params (this is where location will go)
      },
    });

    const fetchedAnimals = response.data.animals;
    if (!fetchedAnimals || fetchedAnimals.length === 0) {
      break;
    }

    const filtered = fetchedAnimals.filter(
      (animal) =>
        animal.videos &&
        animal.videos.some((video) => extractVideoUrl(video.embed))
    );

    animalsForReels.push(...filtered);
    currentPage++;
  }

  return animalsForReels;
};

// This original function now just handles the generic "All" reels
export const buildReelsCache = async (redis, token) => {
  console.log("WORKER: Starting job for generic reels...");
  try {
    const animalsForReels = await fetchAndFilterAnimals(token, {}); // No specific params
    await redis.set(
      REELS_CACHE_KEY,
      JSON.stringify({ animals: animalsForReels })
    );
    console.log(
      `WORKER: Successfully updated generic Reels cache with ${animalsForReels.length} animals.`
    );
  } catch (error) {
    console.error(
      "WORKER: Error building generic reels cache:",
      error.response?.data || error.message
    );
  }
};

/**
 * Fetches and caches reels for a specific location ON-DEMAND.
 * @param {Redis} redis - The Redis client instance.
 * @param {string} token - The Petfinder API token.
 * @param {string} location - The user's location (e.g., "90023" or "Los Angeles, CA").
 * @returns {Promise<Array>} - A promise that resolves to the array of animals for that location.
 */
export const buildReelsForLocation = async (redis, token, location) => {
  console.log(`WORKER-ON-DEMAND: Building reels for location: ${location}`);
  try {
    const animalsForReels = await fetchAndFilterAnimals(token, { location });
    const cacheKey = `${LOCATION_REELS_CACHE_PREFIX}${location}`;

    // Cache the location-specific results with a 30-minute expiry
    await redis.set(
      cacheKey,
      JSON.stringify({ animals: animalsForReels }),
      "EX",
      1800 // 30 minutes
    );

    console.log(
      `WORKER-ON-DEMAND: Successfully cached ${animalsForReels.length} reels for ${location}.`
    );
    return animalsForReels;
  } catch (error) {
    console.error(
      `WORKER-ON-DEMAND: Error building reels for ${location}:`,
      error.response?.data || error.message
    );
    return []; // Return an empty array on error
  }
};
