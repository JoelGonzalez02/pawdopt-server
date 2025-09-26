import Redis from "ioredis";
import dotenv from "dotenv";

dotenv.config();

// Your API limit.
const API_DAILY_LIMIT = 989;
const redis = new Redis(process.env.REDIS_URL);

/**
 * A smart wrapper for making Petfinder API calls.
 * It tracks the daily usage in Redis and acts as a circuit breaker
 * to prevent rate-limiting.
 * @param {Function} requestFunction An async function that performs the axios API call.
 * @returns {Promise<any>} The result of the API call.
 */
export const makeApiCallWithCount = async (requestFunction) => {
  const today = new Date().toISOString().split("T")[0]; // YYYY-MM-DD
  const dailyKey = `petfinder_api_count:${today}`;

  // 1. Check the count BEFORE making the call.
  const currentCount = parseInt((await redis.get(dailyKey)) || "0", 10);

  if (currentCount >= API_DAILY_LIMIT) {
    // This is the circuit breaker.
    console.warn(
      `API TRACKER: Daily limit of ${API_DAILY_LIMIT} reached. Aborting request.`
    );
    throw new Error("Daily API limit reached.");
  }

  // 2. If the limit is not reached, proceed with the API call.
  const response = await requestFunction();

  // 3. After a successful call, increment the counter.
  const newCount = await redis.incr(dailyKey);

  // If this is the first call of the day, set the key to expire in 24 hours.
  if (newCount === 1) {
    await redis.expire(dailyKey, 86400); // 86400 seconds = 24 hours
  }

  console.log(
    `API TRACKER: Daily count is now ${newCount}/${API_DAILY_LIMIT}.`
  );

  return response;
};
