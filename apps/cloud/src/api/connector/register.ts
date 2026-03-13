/**
 * POST /connector/register
 *
 * First-time connector registration. Creates a company row if it doesn't exist
 * and issues a machine token. Also seeds a default config_profile row.
 *
 * Body: { machineId, tallyVersion, osInfo, companyName }
 * Response: { machineToken, companyId, cloudConfig }
 */
import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { sql } from '../../db/db'
import { issueMachineToken } from '../../auth/machine-tokens'
import { logger } from '../../lib/logger'

const RegisterBodySchema = z.object({
    machineId: z.string().min(1),
    tallyVersion: z.string().optional(),
    osInfo: z.string().optional(),
    companyName: z.string().min(1),
    // Optional mapping configs pushed from the connector's local SQLite
    mappingConfigs: z.record(z.unknown()).optional(),
})

export const registerRoute: FastifyPluginAsync = async (fastify) => {
    fastify.post<{ Body: z.infer<typeof RegisterBodySchema> }>(
        '/connector/register',
        {
            schema: {
                body: {
                    type: 'object',
                    required: ['machineId', 'companyName'],
                    properties: {
                        machineId: { type: 'string' },
                        tallyVersion: { type: 'string' },
                        osInfo: { type: 'string' },
                        companyName: { type: 'string' },
                    },
                },
            },
        },
        async (request, reply) => {
            const body = RegisterBodySchema.parse(request.body)

            // Upsert by machine_id so re-registrations don't create duplicate rows.
            // The unique index is partial (WHERE machine_id IS NOT NULL) so the
            // conflict target must include the predicate.
            const [company] = await sql<{ id: string }[]>`
        INSERT INTO companies (tally_company_name, tally_version, connector_status, machine_id)
        VALUES (${body.companyName}, ${body.tallyVersion ?? null}, 'ONLINE', ${body.machineId})
        ON CONFLICT (machine_id) WHERE machine_id IS NOT NULL DO UPDATE
          SET tally_company_name = EXCLUDED.tally_company_name,
              connector_status   = 'ONLINE',
              tally_version      = EXCLUDED.tally_version
        RETURNING id
      `
            const companyId = company!.id

            // Seed / update config_profile with mapping configs from connector.
            // Pass raw objects (not JSON.stringify'd) to avoid JSONB double-encoding.
            const mc = body.mappingConfigs ?? {}
            const acctMap  = (mc.account_coa  as Record<string,unknown>) ?? {}
            const gstMap   = (mc.gst_ledger   as Record<string,unknown>) ?? {}
            const vtMap    = (mc.voucher_type  as Record<string,unknown>) ?? {}
            const sdMap    = (mc.sync_direction as Record<string,unknown>) ?? {}

            await sql`
          INSERT INTO config_profiles (
              company_id,
              account_mappings, gst_ledger_mappings, voucher_type_mappings,
              sync_direction_rules
          )
          VALUES (
              ${companyId},
              ${acctMap}, ${gstMap}, ${vtMap}, ${sdMap}
          )
          ON CONFLICT (company_id) DO NOTHING
        `

            const machineToken = await issueMachineToken(companyId)

            logger.info({ companyId, companyName: body.companyName }, 'Connector registered')

            return reply.code(200).send({
                machineToken,
                companyId,
                cloudConfig: {
                    pollIntervalMinutes: 5,
                    heartbeatIntervalSeconds: 10,
                    jobsEndpoint: '/connector/jobs/pending',
                },
            })
        }
    )
}
