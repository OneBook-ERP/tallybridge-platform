/**
 * POST /dashboard/registration-token
 *
 * Admin calls this to get a one-time token to embed in the connector's cloud URL.
 * The connector sends this token during /connector/register so the company is
 * automatically linked to the admin who generated the token.
 *
 * Token expires in 24 hours. Single-use — consumed on first registration.
 */
import type { FastifyPluginAsync } from 'fastify'
import { randomBytes } from 'crypto'
import { sql } from '../../db/db'
import { requireAdmin, type AdminIdentity } from '../../auth/require-admin'
import type { FastifyRequest } from 'fastify'

type AuthedRequest = FastifyRequest & { adminIdentity: AdminIdentity }

export const registrationTokenRoutes: FastifyPluginAsync = async (app) => {
    app.addHook('preHandler', requireAdmin)

    // POST /dashboard/registration-token — generate a new token
    app.post('/dashboard/registration-token', async (req, reply) => {
        const identity = (req as AuthedRequest).adminIdentity
        const token = randomBytes(18).toString('base64url') // 24 url-safe chars

        await sql`
            INSERT INTO registration_tokens (token, admin_id)
            VALUES (${token}, ${identity.adminId})
        `

        return reply.code(201).send({
            token,
            expiresIn: '24 hours',
            // Full URL the user pastes into the connector setup
            cloudUrl: `${process.env.PUBLIC_URL ?? ''}/connector/register?token=${token}`,
        })
    })

    // GET /dashboard/registration-token/status — list recent tokens for this admin
    app.get('/dashboard/registration-token/status', async (req) => {
        const identity = (req as AuthedRequest).adminIdentity

        const tokens = await sql`
            SELECT rt.id, rt.token, rt.expires_at, rt.consumed_at, rt.created_at,
                   c.tally_company_name
            FROM registration_tokens rt
            LEFT JOIN companies c ON c.id = rt.company_id
            WHERE rt.admin_id = ${identity.adminId}
            ORDER BY rt.created_at DESC
            LIMIT 10
        `
        return { tokens }
    })
}
