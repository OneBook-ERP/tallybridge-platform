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
    stockGroups: z.array(z.record(z.unknown())).optional(),
    uom: z.array(z.record(z.unknown())).optional(),
    godowns: z.array(z.record(z.unknown())).optional(),
    ledgerGroups: z.array(z.record(z.unknown())).optional(),
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

            // Each batch from the connector contains exactly one master type or vouchers.
            // Priority: ledger > stockItem > stockGroup > uom > godown > voucher
            let recordType: 'voucher' | 'ledger' | 'stockItem' | 'stockGroup' | 'uom' | 'godown' = 'voucher'
            let records: unknown[]
            if (body.ledgers?.length) {
                recordType = 'ledger'
                records = body.ledgers
            } else if (body.stockItems?.length) {
                recordType = 'stockItem'
                records = body.stockItems
            } else if (body.stockGroups?.length) {
                recordType = 'stockGroup'
                records = body.stockGroups
            } else if (body.uom?.length) {
                recordType = 'uom'
                records = body.uom
            } else if (body.godowns?.length) {
                recordType = 'godown'
                records = body.godowns
            } else {
                records = body.vouchers ?? []
            }

            if (records.length === 0) {
                return reply.send({ ok: true, batchId, queued: 0 })
            }

            await enqueueSyncBatch({
                companyId: body.companyId,
                batchId,
                recordType,
                records,
                fromTimestamp: body.fromTimestamp,
                toTimestamp: body.toTimestamp,
                ledgerGroups: recordType === 'ledger' ? (body.ledgerGroups ?? []) : undefined,
            })

            logger.info({ companyId: body.companyId, batchId, count: records.length }, 'Sync data enqueued')
            return reply.send({ ok: true, batchId, queued: records.length })
        },
    )
}
