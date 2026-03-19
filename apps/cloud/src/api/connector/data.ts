/**
 * GET /connector/exceptions  — returns exceptions for the authenticated connector's company
 * GET /connector/sync-records — returns sync records for the authenticated connector's company
 *
 * Auth: Bearer machineToken (same as all other /connector/* routes)
 * These endpoints let the desktop connector app display sync status without
 * needing a separate admin JWT.
 */
import type { FastifyPluginAsync, FastifyRequest } from 'fastify'
import { sql } from '../../db/db'
import { requireConnectorAuth, type ConnectorIdentity } from '../../auth/machine-tokens'
import { logger } from '../../lib/logger'

type AuthedRequest = FastifyRequest & { connectorIdentity?: ConnectorIdentity }

export const connectorDataRoute: FastifyPluginAsync = async (fastify) => {
    // GET /connector/exceptions?limit=N
    fastify.get(
        '/connector/exceptions',
        { preHandler: [requireConnectorAuth] },
        async (request: AuthedRequest, reply) => {
            const companyId = request.connectorIdentity!.companyId
            const limit = Math.min(Number((request.query as Record<string, string>).limit) || 200, 500)

            const rows = await sql<
                {
                    id: string
                    tier: string
                    document_ref: string
                    error_code: string
                    error_message: string
                    created_at: string
                    resolved_at: string | null
                }[]
            >`
                SELECT id, tier, document_ref, error_code, error_message,
                       created_at, resolved_at
                FROM exception_register
                WHERE company_id = ${companyId}
                ORDER BY created_at DESC
                LIMIT ${limit}
            `

            return reply.send({ exceptions: rows })
        },
    )

    // GET /connector/sync-records?limit=N
    fastify.get(
        '/connector/sync-records',
        { preHandler: [requireConnectorAuth] },
        async (request: AuthedRequest, reply) => {
            const companyId = request.connectorIdentity!.companyId
            const limit = Math.min(Number((request.query as Record<string, string>).limit) || 300, 500)

            const rows = await sql<
                {
                    id: string
                    tally_voucher_number: string | null
                    tally_guid: string
                    erpnext_doctype: string | null
                    erpnext_name: string | null
                    sync_status: string
                    direction: string
                    last_synced_at: string | null
                }[]
            >`
                SELECT id, tally_voucher_number, tally_guid,
                       erpnext_doctype, erpnext_name, sync_status, direction, last_synced_at
                FROM sync_records
                WHERE company_id = ${companyId}
                ORDER BY last_synced_at DESC NULLS LAST
                LIMIT ${limit}
            `

            return reply.send({ records: rows })
        },
    )

    // POST /connector/reprocess-exceptions — mark retryable exceptions as resolved
    // and delete their sync_records so the connector re-pushes on next sync.
    fastify.post(
        '/connector/reprocess-exceptions',
        { preHandler: [requireConnectorAuth] },
        async (request: AuthedRequest, reply) => {
            const companyId = request.connectorIdentity!.companyId
            const { errorCode, exceptionIds } = (request.body ?? {}) as {
                errorCode?: string
                exceptionIds?: string[]
            }
            const code = errorCode ?? 'ERPNEXT_WRITE_FAILED'
            const retryableCodes = ['FALLBACK_TO_JOURNAL', 'ERPNEXT_WRITE_FAILED', 'MASTER_CREATE_FAILED']

            let openExceptions: { id: string; document_ref: string }[]
            if (exceptionIds && exceptionIds.length > 0) {
                openExceptions = await sql<{ id: string; document_ref: string }[]>`
                    SELECT id, document_ref FROM exception_register
                    WHERE company_id = ${companyId}
                      AND id = ANY(${exceptionIds})
                      AND resolved_at IS NULL
                `
            } else {
                openExceptions = await sql<{ id: string; document_ref: string }[]>`
                    SELECT id, document_ref FROM exception_register
                    WHERE company_id = ${companyId}
                      AND error_code = ${code}
                      AND resolved_at IS NULL
                `
            }

            if (retryableCodes.includes(code) || exceptionIds) {
                const guids = openExceptions.map((e) => e.document_ref.replace(/^Voucher:/, '')).filter(Boolean)
                if (guids.length > 0) {
                    await sql`DELETE FROM sync_records WHERE company_id = ${companyId} AND tally_guid = ANY(${guids})`
                }
            }

            const ids = openExceptions.map((e) => e.id)
            let resolvedCount = 0
            if (ids.length > 0) {
                await sql`
                    UPDATE exception_register
                    SET resolved_at = now(), resolved_by = 'connector:reprocess'
                    WHERE id = ANY(${ids})
                `
                resolvedCount = ids.length
            }

            logger.info({ companyId, code, resolved: resolvedCount }, 'Connector reprocess-exceptions')
            return reply.send({ ok: true, resolved: resolvedCount })
        },
    )
}
