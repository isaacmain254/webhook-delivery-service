# Webhook Delivery Service

## Run with Docker Compose

1. If you do not already have a `.env` file, copy `.env.example` to `.env`.
   Otherwise, add or adjust the database and port variables there without
   overwriting your existing settings.
2. Start the API, worker, PostgreSQL, and Redis:

   ```sh
   docker compose up --build
   ```

3. Open <http://localhost:5000>.

Compose passes the database credentials to PostgreSQL through environment
variables. The `api` and `worker` services load the whole `.env` file via
`env_file`, so new application settings only need to be added to `.env` (and
`.env.example`) rather than to `docker-compose.yml`. The compose file overrides
only the values that differ inside the Docker network: `DATABASE_URL` points at
the `postgres` service, `REDIS_URL` at `redis`, and `NODE_ENV` is `production`.
The `DATABASE_URL` in `.env` is used by Prisma commands run directly on the
host. Compose still reads `.env` for `${...}` interpolation of ports and the
PostgreSQL credentials.

## Prisma migrations

Do not run migrations in the Dockerfile. Image builds should not need a running
database, and running migrations during a build can affect the wrong database.

The Prisma client is generated into `src/generated/prisma`. The `dev` and
`build` scripts generate it automatically; to regenerate it after schema
changes, run `npm run prisma:generate`.

For local development, start PostgreSQL with `docker compose up -d postgres`,
then create and apply migrations from the host:

```sh
npx prisma migrate dev --name init
```

For deployment, build the API image and run the deploy command as a one-off
container before starting or updating the API:

```sh
docker compose build api
docker compose run --rm api npx prisma migrate deploy
docker compose up -d api
```

`migrate deploy` applies existing migration files; it does not create migrations.

## API errors and request limits

Errors use one response shape:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Request validation failed",
    "details": [{ "path": "body.username", "message": "Too small: expected string to have >=3 characters" }]
  }
}
```

`details` is always present and is an empty array when there are no field-specific
details. Status codes are consistent across routes:

- `400 INVALID_JSON` for a body that is not valid JSON.
- `401 UNAUTHORIZED` for a missing, malformed, or unknown `X-API-Key`.
- `404 NOT_FOUND` for unknown routes and for missing or foreign-owned resources.
  Cross-user access deliberately returns `404` instead of `403`.
- `409` for conflicts. Domain-specific codes include `USERNAME_TAKEN`,
  `IDEMPOTENCY_KEY_REUSED`, and `DELIVERY_NOT_REPLAYABLE`.
- `413 PAYLOAD_TOO_LARGE` when either request-size limit is exceeded.
- `422 VALIDATION_ERROR` for invalid bodies, route parameters, or query parameters.
- `500 INTERNAL_ERROR` for unexpected failures. These responses never include
  stack traces, database details, API keys, or signing secrets.

All bodies, UUID path parameters, and query parameters are validated with Zod.
Resource routes currently accept no query parameters, so unexpected query keys
are rejected. `JSON_BODY_LIMIT_BYTES` (1 MiB by default) bounds the whole JSON
request, while the smaller `MAX_EVENT_PAYLOAD_BYTES` (64 KiB by default) is
enforced against the canonical event payload independently.

## API documentation

The generated OpenAPI 3.0.3 document is the canonical API contract:

- `GET /openapi.json` returns the raw document. It is public and can be imported
  into Postman, Insomnia, generated clients, or contract-testing tools.
- `GET /docs` serves the interactive Stoplight Elements reference. It is also
  public. The Stoplight JavaScript and CSS are served from the pinned npm
  package rather than a CDN, so the page also works without external network
  access.

The document is generated from the same Zod schemas used for request validation
and includes every health, user, endpoint, event, and delivery operation. The
API-key security scheme (`X-API-Key`) is applied to protected operations so
Stoplight's "Try it" feature can send authenticated requests.

## Webhook endpoints

Every endpoint route requires an `X-API-Key` header. Create a user with
`POST /v1/users` and use the API key it returns.

- `POST /v1/endpoints` accepts `{ "url": "https://...", "events": [...] }`.
  `events` is optional and defaults to no subscriptions. This response is the
  only one that includes `signingSecret`; store it to verify delivery
  signatures, because it cannot be retrieved later.
- `GET /v1/endpoints` and `GET /v1/endpoints/:id` never return the signing
  secret.
- `PATCH /v1/endpoints/:id` updates `url` and/or `status`
  (`ACTIVE` / `INACTIVE`). New URLs are revalidated.
- `PUT /v1/endpoints/:id/subscriptions` replaces the whole subscription list;
  an empty list unsubscribes everything. Event types must come from the fixed
  catalog: `payment.created`, `payment.succeeded`, `payment.failed`,
  `payment.canceled`, `payment.refunded`, `payment.disputed`,
  `invoice.created`, `invoice.paid`, `invoice.payment_failed`,
  `payout.created`, `payout.paid`, `payout.failed`.
- `DELETE /v1/endpoints/:id` removes the endpoint and cascades to its
  subscriptions and delivery records.

Every query is scoped to the authenticated user. Another user's endpoint
returns `404`, the same response as a missing endpoint.

### Destination policy (SSRF protection)

Destinations are validated when an endpoint is created and whenever its URL
changes:

- HTTP(S) only, and no embedded credentials. HTTPS is required when
  `REQUIRE_HTTPS_DESTINATIONS=true` (the default) and always in production.
- Loopback, private, link-local, carrier-grade NAT, multicast, reserved and
  test ranges (IPv4 and IPv6), IPv4-mapped IPv6 addresses, and known cloud
  metadata hosts are rejected with `422` and a generic error.
- Hostnames are resolved and every returned address must be public. The
  validated addresses are returned by `validateWebhookUrl` and pinned with
  `createPinnedLookup` so the outbound request cannot be redirected to a
  different address by a second DNS lookup (DNS rebinding).
- Outbound delivery requests must use the pinned lookup and must not follow
  redirects without revalidating every destination the same way.

Rejected destinations are never stored.

### Delivery behavior when an endpoint changes

- Deactivating an endpoint (`INACTIVE`) stops new events from fanning out to
  it. Deliveries that are already queued are still attempted.
- Changing the URL applies to queued deliveries: the worker loads the current
  URL when it sends.
- Deleting an endpoint cancels its queued deliveries by removing them
  (cascade), together with their attempt history.

## Submitting events

`POST /v1/events` accepts an event and fans it out to the user's `ACTIVE`
endpoints that subscribe to its type:

```json
{
  "idempotencyKey": "order-123-attempt-1",
  "eventType": "payment.succeeded",
  "payload": { "amount": 1000, "currency": "usd" }
}
```

- `202 Accepted` for a new event. The response includes the event, one
  delivery per matching endpoint, and `"replayed": false`.
- `200 OK` when the same user submits the same idempotency key with the same
  event type and payload. The original event is returned with
  `"replayed": true` and the header `X-Idempotency-Replay: true`; no new
  records are created. Object-key order does not matter.
- `409 Conflict` when the key was already used with a different event type or
  payload.
- `422` for unknown event types or malformed requests.
- `413` when the payload exceeds `MAX_EVENT_PAYLOAD_BYTES` (64 KiB by default)
  or the request body exceeds `JSON_BODY_LIMIT_BYTES` (1 MiB by default).

Event creation, delivery fan-out, and outbox records are written in a single
database transaction. Deliveries start as `PENDING` with `retryCount = 0` and
`nextAttempt` set to creation time; the worker's outbox dispatcher publishes
their outbox records to BullMQ.

### Delivered request format

The delivery worker sends `POST` requests with this JSON envelope:

```json
{
  "id": "<event id>",
  "type": "payment.succeeded",
  "createdAt": "2026-10-20T12:00:00.000Z",
  "data": { "amount": 1000, "currency": "usd" }
}
```

Headers:

- `X-Webhook-Event-Id`
- `X-Webhook-Event-Type`
- `X-Webhook-Delivery-Id` (stable across retries)
- `X-Webhook-Timestamp` (Unix seconds)
- `X-Webhook-Signature: sha256=<hex>`

The signature is HMAC-SHA256 over the exact bytes of
`timestamp + "." + body`. To verify it, use the endpoint's `signingSecret` and
the raw request body, not a re-serialized JSON object. Receivers should also
reject timestamps outside their freshness window.

## Delivery worker, retries, and attempt history

The BullMQ worker (`src/worker.ts`) claims one delivery atomically before
sending it. The claim checks that the delivery is `PENDING` or `RETRYING`, that
`nextAttempt` is due, and that no active lease exists. The outbound HTTP request
is never made inside a database transaction.

- The endpoint URL is revalidated at delivery time and the request uses the
  pinned, validated DNS addresses.
- Requests time out after `DELIVERY_TIMEOUT_MS` (30 seconds by default).
- Redirects are not followed. `3xx` responses are permanent failures.
- Response bodies are bounded by `MAX_RESPONSE_BODY_BYTES` (4 KiB by default).
  Only a sanitized, truncated summary is stored in the delivery and attempt.
- `2xx` marks the delivery `SUCCEEDED`.
- `408`, `429`, `5xx`, timeouts, and network failures mark it `RETRYING` until
  the attempt limit is reached.
- Other `4xx` responses and destination-policy rejections mark it `FAILED`.

`retryCount` counts retries already scheduled: the attempt number is
`retryCount + 1`. A retry is scheduled only while the attempt number is below
`MAX_DELIVERY_ATTEMPTS` (5 by default); no retry is scheduled after the final
permitted attempt.

Retry delays use application-controlled exponential backoff with jitter:

```text
base   = min(MAX_RETRY_DELAY_MS, INITIAL_RETRY_DELAY_MS * 2^(attemptNumber - 1))
jitter = base * 0.20 * random()
delay  = min(MAX_RETRY_DELAY_MS, base + jitter)
```

If a retryable response includes `Retry-After`, both delta-seconds and
HTTP-date forms are parsed. The retry waits for the longer of the backoff and
the header value, capped by `MAX_RETRY_DELAY_MS`. Malformed or past values are
ignored.

The retry transaction sets `nextAttempt` and makes the outbox row dispatchable
again with a new generation. The dispatcher passes the remaining delay to
BullMQ, so the retry job is not run early. If a worker lease expires while a
delivery is `PROCESSING`, the reconciler reclaims it, closes any incomplete
attempt as `LEASE_EXPIRED`, and consumes one retry before scheduling the next
attempt. This avoids an unbounded crash loop while preserving at-least-once
delivery semantics. A late completion from the original worker cannot overwrite
the recovered delivery state; its attempt result is still recorded.

Attempt history is stored in `DeliveryAttempts`, including the replay cycle,
attempt number, start/completion times, HTTP status, duration, and the sanitized
response or network-error summary. Attempt records do not contain request
headers, the signing secret, or the event payload.

`replayCount` starts at `0`. A manual replay increments it and restarts
`retryCount` at `0`, so attempts are identified by
`(deliveryId, replayCount, attemptCount)`. Existing attempts are never deleted.

## Inspecting deliveries and manual replay

All inspection and replay routes require `X-API-Key` and are scoped to the
authenticated user. Missing resources and resources owned by another user both
return `404`.

- `GET /v1/events/:id` returns the event type, idempotency key, payload, and a
  summary of each delivery.
- `GET /v1/events/:id/deliveries` returns the event's delivery summaries.
- `GET /v1/deliveries/:id` returns the delivery state, latest HTTP outcome,
  event summary, and endpoint summary. Worker lease fields and signing secrets
  are not exposed.
- `GET /v1/deliveries/:id/attempts` returns the complete attempt history ordered
  by replay cycle then attempt number. Stored response summaries are already
  sanitized and truncated.
- `POST /v1/deliveries/:id/replay` schedules a new cycle for a `FAILED` or
  `SUCCEEDED` delivery.

Replaying a `SUCCEEDED` delivery is an intentional redelivery, not recovery
from a failure. Replay is rejected with `409 DELIVERY_NOT_REPLAYABLE` while the
delivery is `PENDING`, `PROCESSING`, or `RETRYING`.

A replay is one atomic transaction: the delivery becomes `PENDING` with
`retryCount = 0`, `replayCount` is incremented, stale outcome and lease fields
are cleared, and the outbox row is made dispatchable with a new generation. The
outbox record provides durable scheduling. Concurrent replay requests cannot
both win; one receives `202 Accepted`, and the others receive `409`. The `202`
reports the scheduled `PENDING` state, not successful delivery.

## Outbox dispatcher and reconciliation

The worker process (`npm run worker` or the Compose `worker` service) runs the
BullMQ delivery worker plus two scheduling loops:

- **Dispatcher** — every `OUTBOX_POLL_INTERVAL_MS` (5 seconds by default) it
  claims up to `OUTBOX_BATCH_SIZE` (50) unpublished outbox rows with
  `FOR UPDATE SKIP LOCKED`, publishes BullMQ jobs containing only
  `{ "deliveryId": "..." }`, and marks each row published only after Redis
  confirms the job. If the delivery's `nextAttempt` is in the future, the
  BullMQ job is published with the corresponding delay. Publication failures
  release the claim and leave the row unpublished for the next poll. Claims use
  a `lockedUntil` / `lockedBy` lease (`OUTBOX_LEASE_DURATION_MS`, 30 seconds),
  so work claimed by a crashed dispatcher is recovered after the lease
  expires.
- **Reconciler** — every `OUTBOX_RECONCILE_INTERVAL_MS` (60 seconds) it first
  recovers `PROCESSING` deliveries whose `lockedUntil` expired (or is missing).
  Recovery uses `FOR UPDATE SKIP LOCKED` and reschedules or fails the delivery
  according to the remaining attempt budget. It then looks for `PENDING` or
  `RETRYING` deliveries that are due and not leased by a worker
  (`OUTBOX_RECONCILE_BATCH_SIZE`, 100), creates a missing outbox row, and
  resets a published outbox row whose BullMQ job has disappeared.

Job IDs are `delivery-<outboxRecordId>-g<generation>`. A dispatcher crash after
publishing but before marking the row published republishes with the same job
ID, so BullMQ still holds one logical job; a legitimate reschedule increments
the generation. PostgreSQL remains the source of truth and BullMQ jobs have no
automatic retries of their own.

## Health checks and structured logging

### HTTP health endpoints

- `GET /v1/health` — readiness. Pings PostgreSQL and Redis concurrently, each
  with a 2-second timeout, and reports the result with:

  ```json
  { "status": "ok", "db": "ok", "redis": "ok" }
  ```

  When a dependency is unreachable the status is `degraded`, the failing
  dependency is reported as `unavailable`, and the HTTP status is `503`.
  Postgres and Redis outages must therefore be visible in the health response,
  a "degraded" (rather than dead) process state.

- `GET /v1/health/live` — liveness process check. Always reports
  `{ "status": "ok" }` and never touches PostgreSQL or Redis, so a dependency
  outage does not get treated as a crashed process.

### Worker health

The worker exposes a small HTTP surface on `WORKER_HEALTH_PORT` (default
`5001`, `0` disables it) inside its own process:

- `/live` — process-up probe.
- `/ready` — readiness plus a `worker: running | stopping` flag that flips as
  soon as a `SIGTERM`-triggered drain starts. Postgres/Redis outages yield
  `status: degraded` and the corresponding `unavailable` field.

The Compose `worker` service polls `/live` with a `healthcheck`. The API
container's `healthcheck` polls `/v1/health` so a dependency outage is
reflected in container health.

### Structured logs

API and worker write JSON logs (Pino). Levels (`LOG_LEVEL`,
`info` by default), timestamps, messages, and context fields:

- `level`, `time`, and `msg` are always present.
- API requests are logged with `req.method`, `req.url`, `responseTime`,
  status, and `requestId`. Each request receives a `requestId`; clients can
  supply their own via the `X-Request-Id` request header and read it back from
  the `X-Request-Id` response header. Pass it downstream to correlate logs
  across services.
- Worker logs carry `eventId`, `deliveryId`, `outboxId`, and `jobId` ids of
  interest plus `component: worker | dispatcher | reconciler | queue | api`.

Secrets are never logged and, as defense in depth, the logger strips
`apiKey`, `signingSecret`, `authorization` and similar keys (`X-API-Key`,
`eventPayload`) from any context. Responses with sensitive bodies are
truncated upstream and never dumped as-is.

### Shutdown

`LEASE_DURATION_MS` must be greater than `DELIVERY_TIMEOUT_MS` so a request
cannot normally outlive its database lease while still running.

Both processes shut down gracefully on `SIGTERM` or `SIGINT`, stopping their
schedulers, closing the HTTP servers (API and worker health listener), flush
BullMQ and Prisma resources, and exit `0` on a clean drain. The `stopping`
flag on `GET /ready` goes `stopping` as soon as the drain begins.

## Tests

`npm test` runs the unit and integration suites with Vitest and requires
PostgreSQL to be reachable (for example, `docker compose up -d postgres`). The
Vitest global setup creates a disposable `webhook_service_test_*` database,
applies the Prisma migrations to it, points the tests at it, and drops it
again when the run finishes. The database referenced by `DATABASE_URL` is only
used to create the temporary database and is never modified by tests. Redis is
not required: outbox dispatcher and reconciliation tests use an in-memory queue
fake, delivery worker tests use a recording transport, and the BullMQ adapter
and worker are unit-tested with mocked classes. The real HTTP transport is
tested against a local loopback server with an injected destination validator.
