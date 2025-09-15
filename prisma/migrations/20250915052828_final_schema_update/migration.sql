-- CreateTable
CREATE TABLE "public"."AnimalWithVideo" (
    "id" INTEGER NOT NULL,
    "city" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "animalType" TEXT NOT NULL,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "rawJson" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AnimalWithVideo_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AnimalWithVideo_city_state_animalType_idx" ON "public"."AnimalWithVideo"("city", "state", "animalType");
