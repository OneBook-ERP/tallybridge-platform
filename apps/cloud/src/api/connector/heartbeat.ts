/**
 * POST /connector/heartbeat
 *
 * Connector calls this every 10 seconds. Updates company status in DB + Redis,
 * then broadcasts to dashboard via WebSocket.
 *
 * Auth: Bearer machineToken
 * Body: { companyId, tallyStatus, tallyVersion, openCompany,
 *          pendingLocalJobs, lastTallySyncAt }
 */
import type { FastifyPluginAsync, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { sql } from '../../db/db'
import { requireConnectorAuth, type ConnectorIdentity } from '../../auth/machine-tokens'
import { broadcaster } from '../../realtime/broadcaster'
import { logger } from '../../lib/logger'

const HeartbeatBodySchema = z.object({
    companyId: z.string().uuid(),
    tallyStatus: z.enum(['ONLINE', 'OFFLINE']),
    tallyVersion: z.string().optional(),
    openCompany: z.string().optional(),
    pendingLocalJobs: z.number().int().min(0).default(0),
    lastTallySyncAt: z.string().optional(), // yyyymmddHHmmss
})

type AuthedRequest = FastifyRequest & { connectorIdentity?: ConnectorIdentity }

export const heartbeatRoute: FastifyPluginAsync = async (fastify) => {
    fastify.post<{ Body: z.infer<typeof HeartbeatBodySchema> }>(
        '/connector/heartbeat',
        { preHandler: [requireConnectorAuth] },
        async (request: AuthedRequest, reply) => {
            const body = HeartbeatBodySchema.parse(request.body)

            // Security: ensure the token matches the claimed companyId.
            if (request.connectorIdentity?.companyId !== body.companyId) {
                return reply.code(403).send({ error: 'FORBIDDEN', message: 'Token/companyId mismatch' })
            }

            await sql`
        UPDATE companies SET
          last_heartbeat_at  = now(),
          connector_status   = 'ONLINE',
          tally_status       = ${body.tallyStatus},
          tally_version      = ${body.tallyVersion ?? null}
        WHERE id = ${body.companyId}
      `

            // Broadcast realtime status to all dashboard WebSocket clients.
            broadcaster.emit(body.companyId, 'connector:status', {
                companyId: body.companyId,
                status: 'ONLINE',
                tallyStatus: body.tallyStatus,
                openCompany: body.openCompany,
                at: new Date().toISOString(),
            })

            logger.debug({ companyId: body.companyId, tallyStatus: body.tallyStatus }, 'Heartbeat received')

            return reply.code(200).send({ ok: true })
        }
    )
}
