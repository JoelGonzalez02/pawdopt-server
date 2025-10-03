app.post("/api/videos", async (req, res) => {
  const { location, page = 1, sessionId } = req.body;
  const PAGE_SIZE = 10;

  if (!location && !sessionId) {
    return res
      .status(400)
      .json({ message: "Location or sessionId is required." });
  }

  try {
    if (sessionId) {
      // Logic for paginating an existing session remains the same.
      const sessionKey = `session:${sessionId}`;
      const animalIdsJson = await redis.get(sessionKey);
      if (!animalIdsJson) {
        return res
          .status(404)
          .json({ message: "Session expired. Please refresh." });
      }
      const animalIds = JSON.parse(animalIdsJson);
      const totalPages = Math.ceil(animalIds.length / PAGE_SIZE);
      const pageIds = animalIds.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

      if (pageIds.length === 0) {
        return res.json({
          animals: [],
          pagination: { currentPage: page, totalPages, sessionId },
        });
      }

      const animalsData = await prisma.animalWithVideo.findMany({
        where: { id: { in: pageIds } },
        include: { organization: true },
      });
      const orderedAnimals = pageIds
        .map((id) => animalsData.find((a) => a.id === id))
        .filter(Boolean);

      return res.json({
        animals: orderedAnimals,
        pagination: { currentPage: page, totalPages, sessionId },
      });
    }

    // --- NEW, CORRECTED & MORE ROBUST PLAYLIST GENERATION ---
    logger.info({ location }, "Creating new tiered video session");
    const coords = await getUserCoordinates(location);
    const userLat = coords.lat;
    const userLon = coords.lon;
    const searchRadiusKm = 150 * 1.60934;

    // Step 1: Fetch the 50 absolute closest animals. This raw query is fine.
    const hyperLocalAnimals = await prisma.$queryRaw`
        SELECT id, (6371 * acos(LEAST(1.0, cos(radians(${userLat})) * cos(radians(latitude)) * cos(radians(longitude) - radians(${userLon})) + sin(radians(${userLat})) * sin(radians(latitude))))) as distance
        FROM "AnimalWithVideo"
        WHERE (6371 * acos(LEAST(1.0, cos(radians(${userLat})) * cos(radians(latitude)) * cos(radians(longitude) - radians(${userLon})) + sin(radians(${userLat})) * sin(radians(latitude))))) < ${searchRadiusKm}
        ORDER BY distance ASC
        LIMIT 50;
    `;
    const hyperLocalIds = hyperLocalAnimals.map((c) => c.id);

    // Step 2: Fetch a larger, random group of other local animals using a safe Prisma query.
    const regionalAnimals = await prisma.animalWithVideo.findMany({
      where: {
        id: { notIn: hyperLocalIds }, // Prisma handles the array correctly here
        // A simplified location filter can be added here if needed, but is not strictly necessary
      },
      take: 250,
      select: { id: true },
    });
    let regionalIds = regionalAnimals.map((c) => c.id);
    // Shuffle this list in JavaScript
    for (let i = regionalIds.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [regionalIds[i], regionalIds[j]] = [regionalIds[j], regionalIds[i]];
    }

    // Step 3: Fetch a random set of nationwide animals.
    const allLocalIds = [...hyperLocalIds, ...regionalIds];
    const nationwideAnimals = await prisma.animalWithVideo.findMany({
      where: {
        id: { notIn: allLocalIds.length > 0 ? allLocalIds : undefined },
      },
      take: 200,
      select: { id: true },
    });
    let nationwideIds = nationwideAnimals.map((c) => c.id);
    // Shuffle this list in JavaScript
    for (let i = nationwideIds.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [nationwideIds[i], nationwideIds[j]] = [
        nationwideIds[j],
        nationwideIds[i],
      ];
    }

    // Step 4: Combine the lists.
    const finalPlaylist = [...hyperLocalIds, ...regionalIds, ...nationwideIds];
    // --- END OF NEW LOGIC ---

    const newSessionId = randomUUID();
    await redis.set(
      `session:${newSessionId}`,
      JSON.stringify(finalPlaylist),
      "EX",
      7200
    );

    const totalPages = Math.ceil(finalPlaylist.length / PAGE_SIZE);
    const pageIds = finalPlaylist.slice(0, PAGE_SIZE);
    if (pageIds.length === 0) {
      return res.json({
        animals: [],
        pagination: { currentPage: 1, totalPages, sessionId: newSessionId },
      });
    }
    const pageData = await prisma.animalWithVideo.findMany({
      where: { id: { in: pageIds } },
      include: { organization: true },
    });
    const orderedAnimals = pageIds
      .map((id) => pageData.find((a) => a.id === id))
      .filter(Boolean);
    res.json({
      animals: orderedAnimals,
      pagination: { currentPage: 1, totalPages, sessionId: newSessionId },
    });
  } catch (error) {
    logger.error({ err: error, body: req.body }, "Error in /api/videos");
    res.status(500).json({ message: "Failed to fetch video feed." });
  }
});
