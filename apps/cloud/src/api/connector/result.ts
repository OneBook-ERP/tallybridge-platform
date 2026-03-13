/**
 * POST /connector/sync-result
 *
 * After the connector executes a job (write to Tally), it reports the outcome here.
 * Cloud updates job_log, sync_records, and broadcasts job:completed to the dashboard.
 *
 * Auth: Bearer machineToken
 * Body: { jobId, status, tallyGuid, errorMessage?, tallyResponse? }
 */
import type { FastifyPluginAsync, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { sql } from '../../db/db'
import { requireConnectorAuth, type ConnectorIdentity } from '../../auth/machine-tokens'
import { broadcaster } from '../../realtime/broadcaster'
import { logger } from '../../lib/logger'

const ResultBodySchema = z.object({
    jobId: z.string().uuid(),
    companyId: z.string().uuid(),
    status: z.enum(['SUCCESS', 'ERROR']),
    tallyGuid: z.string().optional(),
    errorMessage: z.string().optional(),
    tallyResponse: z.string().optional(),
})

type AuthedRequest = FastifyRequest & { connectorIdentity?: ConnectorIdentity }

export const resultRoute: FastifyPluginAsync = async (fastify) => {
    fastify.post<{ Body: z.infer<typeof ResultBodySchema> }>(
        '/connector/sync-result',
        { preHandler: [requireConnectorAuth] },
        async (request: AuthedRequest, reply) => {
            const body = ResultBodySchema.parse(request.body)

            if (request.connectorIdentity?.companyId !== body.companyId) {
                return reply.code(403).send({ error: 'FORBIDDEN', message: 'Token/companyId mismatch' })
            }

            // Update job_log row.
            const dbStatus = body.status === 'SUCCESS' ? 'SUCCESS' : 'ERROR'
            await sql`
        UPDATE job_log SET
          status        = ${dbStatus},
          error_message = ${body.errorMessage ?? null},
          completed_at  = now()
        WHERE id = ${body.jobId}
          AND company_id = ${body.companyId}
      `

            // If successful, mark the sync_record as SYNCED.
            if (body.status === 'SUCCESS' && body.tallyGuid) {
                await sql`
          UPDATE sync_records SET
            sync_status    = 'SYNCED',
            last_synced_at = now()
          WHERE company_id = ${body.companyId}
            AND tally_guid = ${body.tallyGuid}
        `
            }

            // Broadcast to dashboard.
            broadcaster.emit(body.companyId, 'job:completed', {
                companyId: body.companyId,
                jobId: body.jobId,
                status: body.status,
            })

            logger.info(
                { jobId: body.jobId, status: body.status, companyId: body.companyId },
                'Connector sync result received'
            )

            return reply.send({ ok: true })
        }
    )
}

/**
 * POST /connector/exception
 * Connector reports a sync error it cannot handle locally.
 */
const ExceptionBodySchema = z.object({
    companyId: z.string().uuid(),
    tier: z.enum(['TIER1_AUTO', 'TIER2_FLAG', 'TIER3_BLOCK']),
    documentRef: z.string().optional(),
    errorCode: z.string(),
    message: z.string(),
})

export const exceptionRoute: FastifyPluginAsync = async (fastify) => {
    fastify.post<{ Body: z.infer<typeof ExceptionBodySchema> }>(
        '/connector/exception',
        { preHandler: [requireConnectorAuth] },
        async (request: AuthedRequest, reply) => {
            const body = ExceptionBodySchema.parse(request.body)

            if (request.connectorIdentity?.companyId !== body.companyId) {
                return reply.code(403).send({ error: 'FORBIDDEN', message: 'Token/companyId mismatch' })
            }

            await sql`
        INSERT INTO exception_register
          (company_id, tier, document_ref, error_code, error_message)
        VALUES
          (${body.companyId}, ${body.tier}, ${body.documentRef ?? null},
           ${body.errorCode}, ${body.message})
      `

            broadcaster.emit(body.companyId, 'exception:new', {
                companyId: body.companyId,
                tier: body.tier,
                documentRef: body.documentRef,
                message: body.message,
            })

            return reply.code(201).send({ ok: true })
        }
    )
}
