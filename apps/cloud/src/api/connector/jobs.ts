/**
 * GET /connector/jobs/pending
 *
 * Step 9 — Long-poll endpoint.
 *
 * The connector calls this continuously. The server holds the connection for
 * up to `timeout` seconds (default 30). If a job arrives for this company while
 * the connection is held, it resolves immediately. Otherwise it returns [].
 *
 * This works without SSE or WebSocket — plain HTTP long-poll is sufficient and
 * works through any firewall since the connector initiates the outbound request.
 *
 * Auth: Bearer machineToken
 * Query: companyId (uuid), timeout (1-30, default 30)
 * Response: { jobs: Job[] }
 */
import type { FastifyPluginAsync, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { requireConnectorAuth, type ConnectorIdentity } from '../../auth/machine-tokens'
import { sql } from '../../db/db'

// ── In-process long-poll registry ─────────────────────────────────────────────
// Map<companyId, Set<(jobs: PendingJob[]) => void>>
// When a job is produced for a company, we resolve all waiting connectors.

export type PendingJob = {
    jobId: string
    action: 'CREATE' | 'ALTER' | 'CANCEL'
    voucherType: string
    payload: Record<string, unknown>
}

type Resolver = (jobs: PendingJob[]) => void

const waitingConnectors = new Map<string, Set<Resolver>>()

/**
 * Wake any connector currently long-polling for companyId.
 * Called by the job producer when a new job is enqueued.
 */
export function wakeConnector(companyId: string, jobs: PendingJob[]): void {
    const resolvers = waitingConnectors.get(companyId)
    if (!resolvers || resolvers.size === 0) return
    for (const resolve of resolvers) {
        resolve(jobs)
    }
    waitingConnectors.delete(companyId)
}

// ── Query Schema ───────────────────────────────────────────────────────────────
const JobsQuerySchema = z.object({
    companyId: z.string().uuid(),
    timeout: z
        .string()
        .optional()
        .transform((v) => Math.min(30, Math.max(1, Number(v ?? '30')))),
})

type AuthedRequest = FastifyRequest & { connectorIdentity?: ConnectorIdentity }

// ── Route ──────────────────────────────────────────────────────────────────────
export const jobsRoute: FastifyPluginAsync = async (fastify) => {
    fastify.get<{ Querystring: { companyId: string; timeout?: string } }>(
        '/connector/jobs/pending',
        { preHandler: [requireConnectorAuth] },
        async (request: AuthedRequest, reply) => {
            const query = JobsQuerySchema.parse(request.query)

            if (request.connectorIdentity?.companyId !== query.companyId) {
                return reply.code(403).send({ error: 'FORBIDDEN', message: 'Token/companyId mismatch' })
            }

            // Check the DB for any already-queued pending jobs first.
            const existing = await sql<{ id: string; job_type: string; payload: Record<string, unknown> }[]>`
        SELECT id, job_type, payload
        FROM job_log
        WHERE company_id = ${query.companyId}
          AND direction  = 'ERP_TO_TALLY'
          AND status     = 'PENDING'
        ORDER BY created_at ASC
        LIMIT 10
      `

            if (existing.length > 0) {
                const jobs: PendingJob[] = existing.map((r) => ({
                    jobId: r.id,
                    action: r.job_type as PendingJob['action'],
                    voucherType: (r.payload as { voucherType?: string }).voucherType ?? '',
                    payload: r.payload,
                }))
                return reply.send({ jobs })
            }

            // No jobs ready — park this connector for up to `timeout` seconds.
            const jobs = await new Promise<PendingJob[]>((resolve) => {
                if (!waitingConnectors.has(query.companyId)) {
                    waitingConnectors.set(query.companyId, new Set())
                }
                waitingConnectors.get(query.companyId)!.add(resolve)

                // Auto-resolve with empty array after timeout.
                const timer = setTimeout(() => {
                    waitingConnectors.get(query.companyId)?.delete(resolve)
                    resolve([])
                }, query.timeout * 1000)

                // Clean up timer if connector disconnects early.
                request.raw.on('close', () => {
                    clearTimeout(timer)
                    waitingConnectors.get(query.companyId)?.delete(resolve)
                    resolve([])
                })
            })

            return reply.send({ jobs })
        },
    )
}
