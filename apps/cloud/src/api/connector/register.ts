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

            // Upsert by (machine_id, tally_company_name) so the same machine can
            // register multiple Tally companies as separate rows, and re-registrations
            // for the same company just refresh the status without touching config.
            const [company] = await sql<{ id: string }[]>`
        INSERT INTO companies (tally_company_name, tally_version, connector_status, machine_id)
        VALUES (${body.companyName}, ${body.tallyVersion ?? null}, 'ONLINE', ${body.machineId})
        ON CONFLICT (machine_id, tally_company_name) WHERE machine_id IS NOT NULL DO UPDATE
          SET connector_status = 'ONLINE',
              tally_version    = EXCLUDED.tally_version
        RETURNING id
      `
            const companyId = company!.id

            // Seed an empty config_profiles row for new companies only.
            // Never overwrite existing config — cloud is the source of truth.
            await sql`
          INSERT INTO config_profiles (company_id)
          VALUES (${companyId})
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
        },
    )
}
