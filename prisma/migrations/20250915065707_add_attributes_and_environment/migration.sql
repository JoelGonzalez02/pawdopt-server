-- AlterTable
ALTER TABLE "public"."AnimalWithVideo" ADD COLUMN     "attributes" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "environment" JSONB NOT NULL DEFAULT '{}';
