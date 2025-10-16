import { PrismaClient, Prisma } from "@prisma/client";
import Redis from "ioredis";
import querystring from "querystring";
import pino from "pino";
import { URL } from "url";
import opencage from "opencage-api-client";

// --- INITIALIZATION ---
const prisma = new PrismaClient();
const redis = new Redis(process.env.REDIS_URL);
const logger = pino({
  transport:
    process.env.NODE_ENV !== "production"
      ? { target: "pino-pretty" }
      : undefined,
});

redis.on("error", (err) => logger.error({ err }, "Redis Client Error"));

// --- HELPER: GET AND CACHE COORDINATES ---
const getUserCoordinates = async (location) => {
  if (!location || typeof location !== "string") return null;

  const sanitizedLocation = location.toLowerCase().replace(/[^a-z0-9,]/g, "");
  const cacheKey = `coords:${sanitizedLocation}`;

  try {
    const cachedCoords = await redis.get(cacheKey);
    if (cachedCoords) {
      logger.info({ location }, `Cache HIT for coordinates`);
      return JSON.parse(cachedCoords);
    }

    logger.info(
      { location },
      `Cache MISS for coordinates. Calling OpenCage API.`
    );
    const geoData = await opencage.geocode({
      q: location,
      key: process.env.OPENCAGE_API_KEY,
    });
    if (!geoData.results || geoData.results.length === 0) {
      throw new Error(`Could not determine coordinates for ${location}`);
    }

    const { lat, lng } = geoData.results[0].geometry;
    const coords = { lat, lon: lng };

    // Cache coordinates for 30 days
    await redis.set(cacheKey, JSON.stringify(coords), "EX", 60 * 60 * 24 * 30);
    return coords;
  } catch (error) {
    logger.error({ err: error, location }, "Failed to get coordinates");
    return null;
  }
};

// --- VERCEL SERVERLESS FUNCTION HANDLER ---
export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ message: "Method Not Allowed" });
  }

  const fullUrl = new URL(req.url, `https://${req.headers.host}`);
  const query = Object.fromEntries(fullUrl.searchParams.entries());

  // 1. Destructure all expected filters from the query
  const {
    type,
    age,
    gender,
    location,
    distance = "100", // Default as string to match query
    page = "1",
    limit = "20",
  } = query;

  const cacheKey = `db-animals:vercel:${querystring.stringify(query)}`;

  try {
    const cachedData = await redis.get(cacheKey);
    if (cachedData) {
      res.setHeader("X-Cache", "HIT");
      return res.status(200).json(JSON.parse(cachedData));
    }
    res.setHeader("X-Cache", "MISS");

    // 2. Build a dynamic 'where' clause for Prisma
    const whereClause = {
      status: "adoptable", // Always get adoptable animals
    };
    if (type) whereClause.type = type;
    if (age) whereClause.age = age;
    if (gender) whereClause.gender = gender;

    let animalIdsInRadius = null;

    // 3. If a location is provided, perform a geospatial search first
    if (location) {
      const coords = await getUserCoordinates(location);
      if (coords) {
        const userLat = coords.lat;
        const userLon = coords.lon;
        const radiusKm = Number(distance) * 1.60934;

        const results = await prisma.$queryRaw`
          SELECT id FROM "AnimalWithVideo"
          WHERE (6371 * acos(LEAST(1.0, cos(radians(${userLat})) * cos(radians(latitude)) * cos(radians(longitude) - radians(${userLon})) + sin(radians(${userLat})) * sin(radians(latitude))))) < ${radiusKm}
        `;
        animalIdsInRadius = results.map((r) => r.id);

        // If no animals are found in the radius, we can stop early
        if (animalIdsInRadius.length === 0) {
          return res
            .status(200)
            .json({
              animals: [],
              pagination: { current_page: 1, total_pages: 0 },
            });
        }

        whereClause.id = { in: animalIdsInRadius };
      }
    }

    const numericPage = Number(page);
    const numericLimit = Number(limit);

    // 4. Fetch the final list of animals from your database
    const animals = await prisma.animalWithVideo.findMany({
      where: whereClause,
      include: { organization: true },
      take: numericLimit,
      skip: (numericPage - 1) * numericLimit,
    });

    // 5. Format the response with the correct pagination shape
    const responseData = {
      animals,
      pagination: {
        current_page: numericPage,
        // Approximate total pages based on the location search result
        total_pages: animalIdsInRadius
          ? Math.ceil(animalIdsInRadius.length / numericLimit)
          : Math.ceil(animals.length / numericLimit), // Fallback if no location
      },
    };

    // Cache the database response for 30 minutes
    await redis.set(cacheKey, JSON.stringify(responseData), "EX", 1800);

    res.status(200).json(responseData);
  } catch (error) {
    logger.error({ err: error.message, query }, "Error in /api/animals");
    res
      .status(500)
      .json({ message: "An error occurred while fetching animals." });
  }
}
