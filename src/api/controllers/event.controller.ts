import type { RequestHandler } from "express";
import type { EventType } from "../../lib/events.js";
import {
  EventPayloadTooLargeError,
  ingestEvent,
} from "../../services/event.service.js";
import { authenticatedUserId } from "./helpers.js";

interface CreateEventBody {
  idempotencyKey: string;
  eventType: EventType;
  payload: Record<string, unknown>;
}

export const createEvent: RequestHandler = async (req, res, next) => {
  const body = req.body as CreateEventBody;

  try {
    const result = await ingestEvent(authenticatedUserId(req), body);

    if (result.outcome === "conflict") {
      res.status(409).json({
        error: {
          code: "IDEMPOTENCY_KEY_REUSED",
          message: "Idempotency key was already used for a different payload",
        },
      });
      return;
    }

    const responseBody = {
      ...result.event,
      replayed: result.outcome === "replayed",
    };

    if (result.outcome === "replayed") {
      res.setHeader("X-Idempotency-Replay", "true");
      res.status(200).json(responseBody);
      return;
    }

    res.status(202).json(responseBody);
  } catch (error) {
    if (error instanceof EventPayloadTooLargeError) {
      res.status(413).json({
        error: {
          code: "PAYLOAD_TOO_LARGE",
          message: "Event payload exceeds the configured limit",
        },
      });
      return;
    }

    next(error);
  }
};
