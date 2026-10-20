import prisma from '../db.js'
import config from '../config.js'
import { generateSigningSecret } from '../lib/crypto.js'
import { validateWebhookUrl } from '../lib/ssrf.js'
import type { EndpointStatus } from '../generated/prisma/enums.js'

const endpointSelect = {
  id: true,
  url: true,
  status: true,
  createdOn: true,
  updatedOn: true,
  subscriptions: { select: { event: true } },
} as const

interface EndpointRow {
  id: string
  url: string
  status: EndpointStatus
  createdOn: Date
  updatedOn: Date
  subscriptions: { event: string[] }[]
}

interface EndpointResponse {
  id: string
  url: string
  status: EndpointStatus
  events: string[]
  createdOn: Date
  updatedOn: Date
}

function toEndpointResponse(endpoint: EndpointRow): EndpointResponse {
  return {
    id: endpoint.id,
    url: endpoint.url,
    status: endpoint.status,
    events: endpoint.subscriptions[0]?.event ?? [],
    createdOn: endpoint.createdOn,
    updatedOn: endpoint.updatedOn,
  }
}

/**
 * Rejects destinations that the service must not call (SSRF policy). HTTPS is
 * required when configured or when running in production.
 */
async function assertAllowedDestination(url: string): Promise<void> {
  await validateWebhookUrl(url, {
    requireHttps: config.REQUIRE_HTTPS_DESTINATIONS || config.NODE_ENV === 'production',
  })
}

export interface CreateEndpointInput {
  url: string
  events?: string[]
}

export async function createEndpointForUser(userId: string, input: CreateEndpointInput) {
  await assertAllowedDestination(input.url)

  const endpoint = await prisma.webhookEndpoint.create({
    data: {
      owner: userId,
      url: input.url,
      signingSecret: generateSigningSecret(),
      status: 'ACTIVE',
      ...(input.events && input.events.length > 0
        ? { subscriptions: { create: { event: input.events } } }
        : {}),
    },
    select: { ...endpointSelect, signingSecret: true },
  })

  // The signing secret is only ever returned here, at creation time.
  return {
    ...toEndpointResponse(endpoint),
    signingSecret: endpoint.signingSecret,
  }
}

export async function listEndpointsForUser(userId: string): Promise<EndpointResponse[]> {
  const endpoints = await prisma.webhookEndpoint.findMany({
    where: { owner: userId },
    orderBy: { createdOn: 'asc' },
    select: endpointSelect,
  })

  return endpoints.map(toEndpointResponse)
}

export async function getEndpointForUser(
  userId: string,
  endpointId: string,
): Promise<EndpointResponse | null> {
  const endpoint = await prisma.webhookEndpoint.findFirst({
    where: { id: endpointId, owner: userId },
    select: endpointSelect,
  })

  return endpoint ? toEndpointResponse(endpoint) : null
}

export interface UpdateEndpointInput {
  url?: string
  status?: EndpointStatus
}

export async function updateEndpointForUser(
  userId: string,
  endpointId: string,
  patch: UpdateEndpointInput,
): Promise<EndpointResponse | null> {
  if (patch.url !== undefined) {
    await assertAllowedDestination(patch.url)
  }

  // Filtering by owner makes cross-user updates impossible; a zero count means
  // the endpoint does not exist or is not owned by this user.
  const result = await prisma.webhookEndpoint.updateMany({
    where: { id: endpointId, owner: userId },
    data: {
      ...(patch.url !== undefined ? { url: patch.url } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
    },
  })

  if (result.count === 0) {
    return null
  }

  return getEndpointForUser(userId, endpointId)
}

export async function replaceEndpointSubscriptions(
  userId: string,
  endpointId: string,
  events: string[],
): Promise<EndpointResponse | null> {
  return prisma.$transaction(async (tx) => {
    const endpoint = await tx.webhookEndpoint.findFirst({
      where: { id: endpointId, owner: userId },
      select: { id: true },
    })

    if (!endpoint) {
      return null
    }

    await tx.subscription.upsert({
      where: { endpointId },
      create: { endpointId, event: events },
      update: { event: events },
    })

    const updated = await tx.webhookEndpoint.findUniqueOrThrow({
      where: { id: endpointId },
      select: endpointSelect,
    })

    return toEndpointResponse(updated)
  })
}

export async function deleteEndpointForUser(userId: string, endpointId: string): Promise<boolean> {
  const result = await prisma.webhookEndpoint.deleteMany({
    where: { id: endpointId, owner: userId },
  })

  return result.count > 0
}
