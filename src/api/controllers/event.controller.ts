import type { RequestHandler, Response } from "express";
import type { EventType } from "../../lib/events.js";
import {
  EventPayloadTooLargeError,
  ingestEvent,
} from "../../services/event.service.js";
import {
  getEventDetailForUser,
  listEventDeliveriesForUser,
} from "../../services/delivery-inspection.service.js";
import { authenticatedUserId, routeParam } from "./helpers.js";

function sendEventNotFound(res: Response): void {
  res.status(404).json({ error: { code: "NOT_FOUND", message: "Event not found" } });
}

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

export const getEvent: RequestHandler = async (req, res, next) => {
  try {
    const event = await getEventDetailForUser(
      authenticatedUserId(req),
      routeParam(req, "id"),
    );

    if (!event) {
      sendEventNotFound(res);
      return;
    }

    res.json(event);
  } catch (error) {
    next(error);
  }
};

export const listEventDeliveries: RequestHandler = async (req, res, next) => {
  try {
    const deliveries = await listEventDeliveriesForUser(
      authenticatedUserId(req),
      routeParam(req, "id"),
    );

    if (!deliveries) {
      sendEventNotFound(res);
      return;
    }

    res.json(deliveries);
  } catch (error) {
    next(error);
  }
};
