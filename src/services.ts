import prisma from "./db.js";
import { type User, WebhookEndpoint } from "./generated/prisma/client.js";

export async function createUser(user: User) {
  return await prisma.user.create({
    data: { username: user.username, apikey: user.apikey },
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
