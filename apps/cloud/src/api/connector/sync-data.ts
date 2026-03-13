/**
 * POST /connector/sync-data
 * The connector ships parsed Tally vouchers to this endpoint after each poll.
 * Enqueues them as a sync-jobs BullMQ job.
 *
 * Auth: Bearer machineToken
 * Body: TallySyncBatch
 */
import type { FastifyPluginAsync, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { randomUUID } from 'crypto'
import { requireConnectorAuth, type ConnectorIdentity } from '../../auth/machine-tokens'
import { enqueueSyncBatch } from '../../queue/producer'
import { logger } from '../../lib/logger'

const SyncDataBodySchema = z.object({
    companyId: z.string().uuid(),
    fromTimestamp: z.string(),
    toTimestamp: z.string(),
    vouchers: z.array(z.record(z.unknown())).optional(),
    ledgers: z.array(z.record(z.unknown())).optional(),
    stockItems: z.array(z.record(z.unknown())).optional(),
})

type AuthedRequest = FastifyRequest & { connectorIdentity?: ConnectorIdentity }

export const syncDataRoute: FastifyPluginAsync = async (fastify) => {
    fastify.post<{ Body: z.infer<typeof SyncDataBodySchema> }>(
        '/connector/sync-data',
        { preHandler: [requireConnectorAuth] },
        async (request: AuthedRequest, reply) => {
            const body = SyncDataBodySchema.parse(request.body)

            if (request.connectorIdentity?.companyId !== body.companyId) {
                return reply.code(403).send({ error: 'FORBIDDEN', message: 'Token/companyId mismatch' })
            }

            const batchId = randomUUID()
            const records: unknown[] = [...(body.vouchers ?? []), ...(body.ledgers ?? []), ...(body.stockItems ?? [])]

            if (records.length === 0) {
                return reply.send({ ok: true, batchId, queued: 0 })
            }

            // Determine record type by content of first record
            let recordType: 'voucher' | 'ledger' | 'stockItem' = 'voucher'
            if (body.ledgers && body.ledgers.length > 0) recordType = 'ledger'
            if (body.stockItems && body.stockItems.length > 0) recordType = 'stockItem'

            await enqueueSyncBatch({
                companyId: body.companyId,
                batchId,
                recordType,
                records,
                fromTimestamp: body.fromTimestamp,
                toTimestamp: body.toTimestamp,
            })

            logger.info({ companyId: body.companyId, batchId, count: records.length }, 'Sync data enqueued')
            return reply.send({ ok: true, batchId, queued: records.length })
        },
    )
}
