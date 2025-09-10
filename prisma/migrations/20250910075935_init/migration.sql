-- CreateTable
CREATE TABLE "public"."users" (
    "id" SERIAL NOT NULL,
    "uuid" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."seen_videos" (
    "user_id" INTEGER NOT NULL,
    "animal_id" INTEGER NOT NULL,
    "seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "seen_videos_pkey" PRIMARY KEY ("user_id","animal_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_uuid_key" ON "public"."users"("uuid");

-- AddForeignKey
ALTER TABLE "public"."seen_videos" ADD CONSTRAINT "seen_videos_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
