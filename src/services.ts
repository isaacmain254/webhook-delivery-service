import prisma from "./db.js";
import { type WebhookEndpoint } from "./generated/prisma/client.js";

export async function createUser(username: string, apiKeyHash: string) {
  return await prisma.user.create({
    data: { username, apiKeyHash },
    select: { id: true, username: true },
  });
}

export async function registerEndpoint(webhook: WebhookEndpoint) {
  return await prisma.webhookEndpoint.create({
    data: {
      owner: webhook.owner,
      url: webhook.url,
      signingSecret: webhook.signingSecret,
      status: webhook.status,
    },
  });
}
