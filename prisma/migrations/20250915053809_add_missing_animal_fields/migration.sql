/*
  Warnings:

  - You are about to drop the column `animalType` on the `AnimalWithVideo` table. All the data in the column will be lost.
  - You are about to drop the column `rawJson` on the `AnimalWithVideo` table. All the data in the column will be lost.
  - Added the required column `age` to the `AnimalWithVideo` table without a default value. This is not possible if the table is not empty.
  - Added the required column `breeds` to the `AnimalWithVideo` table without a default value. This is not possible if the table is not empty.
  - Added the required column `colors` to the `AnimalWithVideo` table without a default value. This is not possible if the table is not empty.
  - Added the required column `contact` to the `AnimalWithVideo` table without a default value. This is not possible if the table is not empty.
  - Added the required column `gender` to the `AnimalWithVideo` table without a default value. This is not possible if the table is not empty.
  - Added the required column `name` to the `AnimalWithVideo` table without a default value. This is not possible if the table is not empty.
  - Added the required column `photos` to the `AnimalWithVideo` table without a default value. This is not possible if the table is not empty.
  - Added the required column `size` to the `AnimalWithVideo` table without a default value. This is not possible if the table is not empty.
  - Added the required column `status` to the `AnimalWithVideo` table without a default value. This is not possible if the table is not empty.
  - Added the required column `type` to the `AnimalWithVideo` table without a default value. This is not possible if the table is not empty.
  - Added the required column `url` to the `AnimalWithVideo` table without a default value. This is not possible if the table is not empty.
  - Added the required column `videos` to the `AnimalWithVideo` table without a default value. This is not possible if the table is not empty.

*/
-- DropIndex
DROP INDEX "public"."AnimalWithVideo_city_state_animalType_idx";

-- AlterTable
ALTER TABLE "public"."AnimalWithVideo" DROP COLUMN "animalType",
DROP COLUMN "rawJson",
ADD COLUMN     "age" TEXT NOT NULL,
ADD COLUMN     "breeds" JSONB NOT NULL,
ADD COLUMN     "colors" JSONB NOT NULL,
ADD COLUMN     "contact" JSONB NOT NULL,
ADD COLUMN     "gender" TEXT NOT NULL,
ADD COLUMN     "name" TEXT NOT NULL,
ADD COLUMN     "photos" JSONB NOT NULL,
ADD COLUMN     "size" TEXT NOT NULL,
ADD COLUMN     "status" TEXT NOT NULL,
ADD COLUMN     "type" TEXT NOT NULL,
ADD COLUMN     "url" TEXT NOT NULL,
ADD COLUMN     "videos" JSONB NOT NULL;

-- CreateIndex
CREATE INDEX "AnimalWithVideo_city_state_type_idx" ON "public"."AnimalWithVideo"("city", "state", "type");
