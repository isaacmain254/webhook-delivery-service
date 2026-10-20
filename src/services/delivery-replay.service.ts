import prisma from '../db.js'
import type { DeliveryStatus } from '../generated/prisma/enums.js'
import { resetOutboxForDelivery } from './outbox.service.js'
import {
  deliveryDetailSelect,
  serializeDeliveryDetail,
  type DeliveryInspectionDetail,
} from './delivery-inspection.service.js'

export type ReplayDeliveryOutcome =
  | { outcome: 'replayed'; delivery: DeliveryInspectionDetail }
  | { outcome: 'not_found' }
  | { outcome: 'conflict'; status: DeliveryStatus }

/**
 * Starts a new delivery cycle from a terminal state.
 *
 * Both FAILED and SUCCEEDED are replayable: a failed delivery is retried, while
 * replaying a successful one is an intentional redelivery. Active deliveries
 * (PENDING, PROCESSING, RETRYING) are rejected.
 *
 * The status guard and the replayCount increment are part of one UPDATE, so two
 * concurrent replay requests cannot both be accepted. The previous attempts
 * remain attached to the delivery under the old replayCount.
 */
export async function replayDeliveryForUser(
  userId: string,
  deliveryId: string,
): Promise<ReplayDeliveryOutcome> {
  return prisma.$transaction(async (tx) => {
    const transitioned = await tx.delivery.updateMany({
      where: {
        id: deliveryId,
        userId,
        status: { in: ['FAILED', 'SUCCEEDED'] },
      },
      data: {
        status: 'PENDING',
        retryCount: 0,
        replayCount: { increment: 1 },
        nextAttempt: new Date(),
        lockedUntil: null,
        lockedBy: null,
        statusCode: null,
        response: null,
        duration: null,
      },
    })

    if (transitioned.count === 0) {
      const current = await tx.delivery.findFirst({
        where: { id: deliveryId, userId },
        select: { status: true },
      })

      return current
        ? { outcome: 'conflict', status: current.status }
        : { outcome: 'not_found' }
    }

    await resetOutboxForDelivery(tx, deliveryId)

    // The transaction still holds the delivery row, so the returned snapshot is
    // the accepted PENDING state even if a worker is ready to claim it.
    const delivery = await tx.delivery.findUniqueOrThrow({
      where: { id: deliveryId },
      select: deliveryDetailSelect,
    })

    return { outcome: 'replayed', delivery: serializeDeliveryDetail(delivery) }
  })
}
