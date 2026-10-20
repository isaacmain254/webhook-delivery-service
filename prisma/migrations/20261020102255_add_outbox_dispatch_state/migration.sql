-- AlterTable
ALTER TABLE "OutboxRecord" ADD COLUMN     "generation" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "lockedBy" TEXT,
ADD COLUMN     "lockedUntil" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "OutboxRecord_published_lockedUntil_idx" ON "OutboxRecord"("published", "lockedUntil");
