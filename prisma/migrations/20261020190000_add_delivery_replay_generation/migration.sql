-- Add an explicit replay cycle so retry numbering can restart without
-- colliding with earlier attempt history.
ALTER TABLE "Delivery" ADD COLUMN     "replayCount" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "DeliveryAttempts" ADD COLUMN     "replayCount" INTEGER NOT NULL DEFAULT 0;

-- Existing attempts belong to the original delivery cycle (replayCount = 0).
-- Fail clearly instead of silently leaving ambiguous attempt history if the
-- old schema contains duplicate logical attempts.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "DeliveryAttempts"
    GROUP BY "deliveryId", "replayCount", "attemptCount"
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Cannot add unique DeliveryAttempts(deliveryId, replayCount, attemptCount): duplicate attempt rows exist; resolve them before migrating';
  END IF;
END $$;

CREATE UNIQUE INDEX "DeliveryAttempts_deliveryId_replayCount_attemptCount_key" ON "DeliveryAttempts"("deliveryId", "replayCount", "attemptCount");
