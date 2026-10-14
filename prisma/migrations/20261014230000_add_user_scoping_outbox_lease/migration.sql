-- Preserve existing rows by deriving ownership from each delivery's endpoint.
-- Abort before making changes if the old schema contains data that cannot be
-- mapped safely or would violate the new uniqueness constraints.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "User"
    WHERE "apikey" !~ '^[0-9a-f]{64}$'
  ) THEN
    RAISE EXCEPTION 'Cannot rename User.apikey to apiKeyHash safely: existing values are not 64-character SHA-256 hashes; hash them with the configured API-key pepper or rotate keys before migrating';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "Subscription"
    GROUP BY "endpointId" HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Cannot add unique Subscription.endpointId: duplicate subscription rows exist; consolidate them before migrating';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "Delivery"
    GROUP BY "eventId", "endpointId" HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Cannot add unique Delivery(eventId, endpointId): duplicate deliveries exist; resolve them before migrating';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "DeliveryAttempts" attempt
    LEFT JOIN "Delivery" delivery ON delivery."id" = attempt."deliveryId"
    WHERE delivery."id" IS NULL
  ) THEN
    RAISE EXCEPTION 'Cannot add DeliveryAttempts foreign key: orphan attempt rows exist; repair them before migrating';
  END IF;

  IF EXISTS (
    SELECT event."id"
    FROM "Event" event
    LEFT JOIN "Delivery" delivery ON delivery."eventId" = event."id"
    LEFT JOIN "WebhookEndpoint" endpoint ON endpoint."id" = delivery."endpointId"
    GROUP BY event."id"
    HAVING COUNT(DISTINCT endpoint."owner") <> 1
  ) THEN
    RAISE EXCEPTION 'Cannot backfill Event.userId: at least one event has no deliveries or deliveries owned by multiple users; assign an owner before migrating';
  END IF;

  IF EXISTS (
    SELECT ownership."owner", event."idempotencyKey"
    FROM "Event" event
    JOIN (
      SELECT delivery."eventId", MIN(endpoint."owner") AS "owner"
      FROM "Delivery" delivery
      JOIN "WebhookEndpoint" endpoint ON endpoint."id" = delivery."endpointId"
      GROUP BY delivery."eventId"
      HAVING COUNT(DISTINCT endpoint."owner") = 1
    ) ownership ON ownership."eventId" = event."id"
    GROUP BY ownership."owner", event."idempotencyKey"
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Cannot add unique Event(userId, idempotencyKey): duplicate keys exist for an owner; resolve them before migrating';
  END IF;
END $$;

ALTER TABLE "User" RENAME COLUMN "apikey" TO "apiKeyHash";

ALTER TABLE "Event" ADD COLUMN "userId" TEXT;
UPDATE "Event" event
SET "userId" = ownership."owner"
FROM (
  SELECT delivery."eventId", MIN(endpoint."owner") AS "owner"
  FROM "Delivery" delivery
  JOIN "WebhookEndpoint" endpoint ON endpoint."id" = delivery."endpointId"
  GROUP BY delivery."eventId"
  HAVING COUNT(DISTINCT endpoint."owner") = 1
) ownership
WHERE event."id" = ownership."eventId";

ALTER TABLE "Event" ALTER COLUMN "userId" SET NOT NULL;
ALTER TABLE "Event" ADD CONSTRAINT "Event_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE UNIQUE INDEX "Event_userId_idempotencyKey_key" ON "Event"("userId", "idempotencyKey");
CREATE INDEX "Event_userId_idx" ON "Event"("userId");

ALTER TABLE "Delivery" ADD COLUMN "userId" TEXT;
ALTER TABLE "Delivery" ADD COLUMN "lockedUntil" TIMESTAMP(3);
ALTER TABLE "Delivery" ADD COLUMN "lockedBy" TEXT;
UPDATE "Delivery" delivery
SET "userId" = endpoint."owner"
FROM "WebhookEndpoint" endpoint
WHERE endpoint."id" = delivery."endpointId";
ALTER TABLE "Delivery" ALTER COLUMN "userId" SET NOT NULL;
ALTER TABLE "Delivery" ADD CONSTRAINT "Delivery_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE UNIQUE INDEX "Delivery_eventId_endpointId_key" ON "Delivery"("eventId", "endpointId");
CREATE INDEX "Delivery_status_idx" ON "Delivery"("status");
CREATE INDEX "Delivery_lockedUntil_idx" ON "Delivery"("lockedUntil");
CREATE INDEX "Delivery_status_lockedUntil_idx" ON "Delivery"("status", "lockedUntil");
CREATE INDEX "Delivery_userId_idx" ON "Delivery"("userId");
CREATE INDEX "Delivery_endpointId_idx" ON "Delivery"("endpointId");

ALTER TABLE "DeliveryAttempts" ADD CONSTRAINT "DeliveryAttempts_deliveryId_fkey"
  FOREIGN KEY ("deliveryId") REFERENCES "Delivery"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "DeliveryAttempts_deliveryId_idx" ON "DeliveryAttempts"("deliveryId");

CREATE UNIQUE INDEX "Subscription_endpointId_key" ON "Subscription"("endpointId");

ALTER TYPE "DeliveryStatus" RENAME VALUE 'SUCCEED' TO 'SUCCEEDED';

CREATE TABLE "OutboxRecord" (
  "id" TEXT NOT NULL,
  "deliveryId" TEXT NOT NULL,
  "published" BOOLEAN NOT NULL DEFAULT false,
  "publishedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "OutboxRecord_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "OutboxRecord_deliveryId_key" ON "OutboxRecord"("deliveryId");
CREATE INDEX "OutboxRecord_published_createdAt_idx" ON "OutboxRecord"("published", "createdAt");
ALTER TABLE "OutboxRecord" ADD CONSTRAINT "OutboxRecord_deliveryId_fkey"
  FOREIGN KEY ("deliveryId") REFERENCES "Delivery"("id") ON DELETE CASCADE ON UPDATE CASCADE;
