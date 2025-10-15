import { PrismaClient } from "@prisma/client";
import pino from "pino";

const prisma = new PrismaClient();
const logger = pino({
  transport:
    process.env.NODE_ENV !== "production"
      ? { target: "pino-pretty" }
      : undefined,
});

export default async function handler(req, res) {
  // --- CORS HEADERS ---
  res.setHeader("Access-Control-Allow-Origin", "*"); // or set to your frontend domain
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  // --- Handle preflight ---
  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  // --- Reject unsupported methods ---
  if (req.method !== "POST") {
    return res.status(405).json({ message: "Method Not Allowed" });
  }

  const { email } = req.body;

  if (!email || !email.includes("@")) {
    return res.status(400).json({ message: "A valid email is required." });
  }

  try {
    const newEntry = await prisma.waitlistEntry.create({
      data: { email: email.toLowerCase() },
    });

    logger.info({ email: newEntry.email }, "New waitlist entry created");
    return res.status(201).json({ message: "Success! You're on the list." });
  } catch (error) {
    if (error.code === "P2002") {
      logger.info({ email }, "Duplicate waitlist entry attempt");
      return res
        .status(409)
        .json({ message: "This email is already on the list." });
    }

    logger.error({ err: error, email }, "Failed to add to waitlist");
    return res
      .status(500)
      .json({ message: "Something went wrong. Please try again later." });
  }
}
