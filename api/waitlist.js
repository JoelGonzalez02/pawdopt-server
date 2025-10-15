import { PrismaClient } from "@prisma/client";

// It's a best practice to instantiate Prisma Client outside the handler
// to allow for connection reuse between function invocations.
const prisma = new PrismaClient();

export default async function handler(request, response) {
  // Only allow POST requests, reject all others
  if (request.method !== "POST") {
    response.setHeader("Allow", ["POST"]);
    return response.status(405).end(`Method ${request.method} Not Allowed`);
  }

  const { email } = request.body;

  // 1. Basic Validation
  if (!email || !email.includes("@")) {
    return response.status(400).json({ message: "A valid email is required." });
  }

  try {
    // 2. Try to save the new email to the database
    const newEntry = await prisma.waitlistEntry.create({
      data: {
        email: email.toLowerCase(), // Store emails in lowercase for consistency
      },
    });
    console.log(`New waitlist entry: ${newEntry.email}`);
    return response
      .status(201)
      .json({ message: "Success! You're on the list." });
  } catch (error) {
    // 3. Handle potential errors, especially duplicate entries
    if (error.code === "P2002") {
      // Prisma's unique constraint violation code
      return response
        .status(409)
        .json({ message: "This email is already on the list." });
    }

    // For all other errors
    console.error("Failed to add to waitlist:", error);
    return response
      .status(500)
      .json({ message: "Something went wrong. Please try again." });
  }
}
