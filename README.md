# Webhook Delivery Service

A webhook delivery service: submit events over an HTTP API, and they are fanned
out durably to your registered HTTPS endpoints — signed with HMAC-SHA256,
retried with backoff, and inspectable/replayable with full attempt history.

**Highlights**

- Transactional ingestion — event, deliveries, and outbox rows commit in one
  database transaction; PostgreSQL is the source of truth.
- Durable `outbox` → BullMQ/Redis scheduling, so Redis is never the only
  record of pending work.
- At-least-once delivery with lease-based crash recovery and reconciliation.
- HMAC-signed deliveries with delivery-scoped secrets and bounded payloads.
- SSRF-safe destinations: validated IPv4/IPv6 addresses, pinned DNS, no
  redirect following.
- Observable: readiness/liveness health checks, structured JSON logs with
  `requestId` correlation, graceful shutdown — all wired into Docker Compose.

## Architecture

```
   POST /v1/events
        │
        ▼
    ┌───────┐  one transaction:  ┌────────────────────────────────┐
    │  API  ├───────────────────▶│ PostgreSQL (source of truth)   │
    └───────┘                    │ events · deliveries · outbox · │
                                 │ delivery_attempts              │
                                 └───────────────┬────────────────┘
                                                 │ unpublished outbox rows
                                                 ▼
   ┌───────────────── worker process ───────────────────────────────┐
   │  dispatcher ──▶ BullMQ (Redis) ──▶ delivery worker             │
   │                      ▲                  │                      │
   │                      │                  │ HMAC-signed POST     │
   │  reconciler ─────────┘                  ▼                      │
   │  (reclaims expired leases)        user endpoint (HTTPS)        │
   └─────────────────────────────────────────────────────────────────┘
```

- The API never sends webhooks. It validates, persists, and enqueues.
- The delivery worker claims a delivery atomically (status + lease check in a
  single SQL update) before any HTTP request leaves the process.
- If a worker dies mid-flight, the reconciler reclaims the lease, closes the
  attempt as `LEASE_EXPIRED`, and spends one retry — no crash loops, no lost
  work.

**Stack:** TypeScript + Express · PostgreSQL + Prisma · Redis + BullMQ · Pino ·
Zod · Vitest · Docker Compose.

## Quick start

```sh
cp .env.example .env
docker compose up --build
```

The API listens on `${PORT:-5000}`; interactive API reference at
`http://localhost:5000/docs`, raw OpenAPI document at `/openapi.json`.
Migrations are applied explicitly (never during image build):

```sh
# fresh host: apply existing migrations as a one-off container
docker compose build api
docker compose run --rm api npx prisma migrate deploy
docker compose up -d api

# local schema development (creates/updates migrations on the host)
docker compose up -d postgres
npx prisma migrate dev --name <name>
```

## API quick start

```sh
# 1. Register a user — the API key is returned exactly once
curl -sS http://localhost:5000/v1/users -H 'Content-Type: application/json' \
  -d '{"username":"acme"}'
# → {"id":"…","username":"acme","apiKey":"…"}

K=<the apiKey>

# 2. Register a destination subscribed to event types
curl -sS http://localhost:5000/v1/endpoints -H "X-API-Key: $K" \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://example.com/hooks","events":["payment.succeeded"]}'
# → 201; the response contains signingSecret (shown once — store it)

# 3. Submit an event (idempotent per key)
curl -sS http://localhost:5000/v1/events -H "X-API-Key: $K" \
  -H 'Content-Type: application/json' \
  -d '{"idempotencyKey":"order-1","eventType":"payment.succeeded","payload":{"amount":4200}}'
# → 202 Accepted: event + one delivery per matching endpoint

# 4. Watch delivery progress
curl -sS http://localhost:5000/v1/events/<eventId> -H "X-API-Key: $K"

# 5. Manually replay a failed delivery
curl -sS -X POST http://localhost:5000/v1/deliveries/<deliveryId>/replay \
  -H "X-API-Key: $K"
```

Full request/response contract, all 15 operations, and error semantics:
`GET /openapi.json` or the interactive `/docs` page.

## How delivery works

- Errors use one shape (`error.code`, `message`, `details`); cross-user and
  missing resources both return `404`; idempotency replays return `200` with
  `X-Idempotency-Replay: true`, key reuse with a different payload → `409`.
- The worker `POST`s `{ id, type, createdAt, data }` with headers
  `X-Webhook-Event-Id`, `X-Webhook-Event-Type`, `X-Webhook-Delivery-Id`,
  `X-Webhook-Timestamp`, and `X-Webhook-Signature: sha256=<hex>`, where the
  HMAC is over `timestamp + "." + body`. Verify with the raw request body and
  the endpoint's signing secret; reject stale timestamps.
- Retry policy: `2xx` → `SUCCEEDED`; `408/429/5xx`, timeouts, network errors →
  `RETRYING`; other `4xx` and policy rejections → `FAILED`. Retries run up to
  `MAX_DELIVERY_ATTEMPTS` (5) with exponential backoff, additive jitter, and
  `Retry-After` support, all capped by `MAX_RETRY_DELAY_MS`.
- Attempt history (`DeliveryAttempts`) records every try with HTTP status,
  duration, and a sanitized, truncated response summary — no secrets, no
  payloads, never deleted. `replayCount` restarts retry numbering without
  erasing history.

## Security

- API keys: 256-bit random, SHA-256 hashed with a server pepper, shown only at
  registration, never logged (denylist redaction as defense in depth).
- Signing secrets: shown only when an endpoint is created; never in list/GET
  responses, logs, or attempt history.
- All resource routes require `X-API-Key`; every query is user-scoped.
- Idempotency, event uniqueness, and one delivery per (event, endpoint) are
  enforced by database constraints, not application checks alone.
- Destination validation rejects loopback/private/link-local/CGNAT/metadata
  ranges (IPv4 and IPv6, including IPv4-mapped IPv6), credentials-in-URL, and
  any host whose DNS resolution yields a prohibited address. Validated
  addresses are pinned per request, so DNS cannot be rebound mid-flight, and
  redirects (`3xx`) are permanent failures, never followed.
- Outbound requests: finite timeouts, bounded response reads (4 KiB
  default), fragment-safe cancellation.
- Limits: 1 MiB JSON body, 64 KiB event payload, validated with Zod.
- 5xx responses are generic (`INTERNAL_ERROR`); unexpected errors are logged
  with context but never returned to clients.

## Operations

| Check | Endpoint | Behavior |
|---|---|---|
| Readiness | `GET /v1/health` | Pings Postgres + Redis (2 s guard each). `200 {status:"ok",db:"ok",redis:"ok"}`; `503 {status:"degraded",…,"unavailable"}` on outage. Docker healthcheck target. |
| API liveness | `GET /v1/health/live` | Dependency-free. |
| Worker probes | `:5001/live`, `/ready` | `/ready` reports dependency states and flips `worker:"stopping"` during drain. |

Logs are JSON (Pino) with `level/time/msg`, `requestId` (echo `X-Request-Id` to
correlate), `eventId`/`deliveryId` on worker lines, and a `component` field.
Both processes stop cleanly on `SIGTERM`/`SIGINT` (drain HTTP, close BullMQ +
Prisma + Redis, exit `0`).

## Tests

```sh
npm install
npm test
```

Vitest unit + integration suites (27 files). The global setup creates a
disposable `webhook_service_test_*` database, applies migrations, and drops it
afterwards; the suite needs PostgreSQL via `DATABASE_URL` but not Redis (queue
and transport are faked/mocked). `TEST_LOG_LEVEL=debug npm test` shows log
output while debugging.

## Known limitations

- No rate limiting on API routes; no authentication brute-force lockout.
- At-least-once, not exactly-once: receivers may see duplicate deliveries
  (safety comes from `X-Webhook-Delivery-Id` + idempotent receivers).
- Single-region single-node deploys only; no horizontal API scaling story,
  no mTLS, no dead-letter UI beyond manual replay.
- No event-type extensions: the catalog of accepted event types is fixed.

**Future work:** rate limiting, delivery batching, receiver-side DKIM-style
rotation, metrics endpoint (Prometheus), and an operations dashboard.
