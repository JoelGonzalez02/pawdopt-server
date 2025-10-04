// api/animals.js

import { PrismaClient } from "@prisma/client";
import Redis from "ioredis";
import axios from "axios";
import querystring from "querystring";
import pino from "pino";
import { NextRequest, NextResponse } from "next/server"; // Import NextRequest

// --- INITIALIZATION ---
const prisma = new PrismaClient();
const redis = new Redis(process.env.REDIS_URL, {
  tls: {
    rejectUnauthorized: false,
  },
});
const logger = pino({
  transport:
    process.env.NODE_ENV !== "production"
      ? { target: "pino-pretty" }
      : undefined,
});

redis.on("error", (err) => logger.error({ err }, "Redis Client Error"));

// --- HELPER: TOKEN MANAGEMENT ---
const PETFINDER_TOKEN_KEY = "petfinder_token";

const getPetfinderToken = async () => {
  let token = await redis.get(PETFINDER_TOKEN_KEY);
  if (token) return token;

  logger.info("Fetching new Petfinder token...");
  try {
    const response = await axios.post(
      "https://api.petfinder.com/v2/oauth2/token",
      querystring.stringify({
        grant_type: "client_credentials",
        client_id: process.env.PETFINDER_CLIENT_ID,
        client_secret: process.env.PETFINDER_CLIENT_SECRET,
      })
    );
    const { access_token, expires_in } = response.data;
    await redis.set(PETFINDER_TOKEN_KEY, access_token, "EX", expires_in - 60);
    logger.info("Successfully fetched and cached new token.");
    return access_token;
  } catch (error) {
    logger.error(
      { err: error.response?.data || error.message },
      "Error fetching Petfinder token"
    );
    throw new Error("Could not fetch token from Petfinder");
  }
};

// --- VERCEL SERVERLESS FUNCTION HANDLER ---
export async function GET(req) {
  // FIX: Use URLSearchParams to get query parameters
  const queryParams = Object.fromEntries(req.nextUrl.searchParams.entries());
  const cacheKey = `animals:enriched:${querystring.stringify(queryParams)}`;

  try {
    const cachedData = await redis.get(cacheKey);
    if (cachedData) {
      return NextResponse.json(JSON.parse(cachedData), {
        headers: { "X-Cache": "HIT" },
      });
    }

    const petfinderToken = await getPetfinderToken();

    const petfinderResponse = await axios.get(
      "https://api.petfinder.com/v2/animals",
      {
        headers: { Authorization: `Bearer ${petfinderToken}` },
        params: queryParams, // Use the parsed query params
      }
    );
    const data = petfinderResponse.data;
    if (!data.animals || data.animals.length === 0) {
      return NextResponse.json(data);
    }

    // --- DATA ENRICHMENT LOGIC (Unchanged) ---
    const orgIds = [...new Set(data.animals.map((a) => a.organization_id))];
    const existingOrgs = await prisma.organization.findMany({
      where: { id: { in: orgIds } },
    });
    const existingOrgIds = new Set(existingOrgs.map((o) => o.id));
    const missingOrgIds = orgIds.filter((id) => !existingOrgIds.has(id));
    const newOrgs = [];

    if (missingOrgIds.length > 0) {
      const orgPromises = missingOrgIds.map((orgId) =>
        axios
          .get(`https://api.petfinder.com/v2/organizations/${orgId}`, {
            headers: { Authorization: `Bearer ${petfinderToken}` },
          })
          .then((response) => response.data.organization)
          .catch(() => null)
      );
      const fetchedOrgs = (await Promise.all(orgPromises)).filter(Boolean);

      if (fetchedOrgs.length > 0) {
        newOrgs.push(...fetchedOrgs);
        await prisma.organization.createMany({
          data: fetchedOrgs.map((org) => ({
            id: org.id,
            name: org.name,
            email: org.email,
            phone: org.phone,
            address: org.address,
            url: org.url,
          })),
          skipDuplicates: true,
        });
      }
    }

    const allOrgs = [...existingOrgs, ...newOrgs];
    data.animals.forEach((animal) => {
      animal.organization =
        allOrgs.find((org) => org.id === animal.organization_id) || null;
    });
    // --- END ENRICHMENT LOGIC ---

    await redis.set(cacheKey, JSON.stringify(data), "EX", 3600);
    return NextResponse.json(data, { headers: { "X-Cache": "MISS" } });
  } catch (error) {
    logger.error(
      { err: error.response?.data || error.message, query: queryParams },
      "Error in /api/animals"
    );
    return new NextResponse("An error occurred while fetching animals.", {
      status: 500,
    });
  }
}
