/**
 * POST /connector/register
 *
 * First-time connector registration. Creates a company row if it doesn't exist
 * and issues a machine token. Also seeds a default config_profile row.
 *
 * If a valid registrationToken is provided, the company is automatically linked
 * to the admin who generated the token (via admin_company_access).
 *
 * Body: { machineId, tallyVersion, osInfo, companyName, registrationToken? }
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
    registrationToken: z.string().optional(), // one-time token from dashboard
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

            // If a registration token was supplied, link company to admin
            if (body.registrationToken) {
                const [tokenRow] = await sql<{ id: string; admin_id: string }[]>`
                    SELECT id, admin_id FROM registration_tokens
                    WHERE token       = ${body.registrationToken}
                      AND consumed_at IS NULL
                      AND expires_at  > now()
                    LIMIT 1
                `
                if (tokenRow) {
                    await sql`
                        INSERT INTO admin_company_access (admin_id, company_id)
                        VALUES (${tokenRow.admin_id}, ${companyId})
                        ON CONFLICT (admin_id, company_id) DO NOTHING
                    `
                    await sql`
                        UPDATE registration_tokens
                        SET consumed_at = now(), company_id = ${companyId}
                        WHERE id = ${tokenRow.id}
                    `
                    logger.info(
                        { companyId, adminId: tokenRow.admin_id },
                        'Company linked to admin via registration token',
                    )
                } else {
                    logger.warn(
                        { token: body.registrationToken },
                        'Registration token invalid or expired — company not linked to admin',
                    )
                }
            }

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
