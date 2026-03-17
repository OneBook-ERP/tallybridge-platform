/**
 * Auth API routes — login, signup, refresh, me.
 */
import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { sql } from '../../db/db'
import { hashPassword, verifyPassword, signAccessToken, signRefreshToken, verifyToken } from '../../auth/admin-auth'
import { requireAdmin, type AdminIdentity } from '../../auth/require-admin'
import { logger } from '../../lib/logger'

const LoginBody = z.object({
    email: z.string().email(),
    password: z.string().min(1),
})

const SignupBody = z.object({
    email: z.string().email(),
    password: z.string().min(6, 'Password must be at least 6 characters'),
    displayName: z.string().min(1).optional(),
})

const RefreshBody = z.object({
    refreshToken: z.string().min(1),
})

export const authRoutes: FastifyPluginAsync = async (app) => {
    // POST /auth/signup — self-service registration (creates company_admin with no companies)
    app.post('/auth/signup', async (req, reply) => {
        const body = SignupBody.safeParse(req.body)
        if (!body.success) {
            reply.code(400).send({
                error: 'VALIDATION_ERROR',
                message: body.error.issues.map((i) => i.message).join(', '),
            })
            return
        }

        const { email, password, displayName } = body.data
        const passwordHash = await hashPassword(password)

        const [admin] = await sql<{ id: string; email: string }[]>`
            INSERT INTO admins (email, password_hash, role, display_name)
            VALUES (${email.toLowerCase()}, ${passwordHash}, 'company_admin', ${displayName ?? null})
            ON CONFLICT (email) DO NOTHING
            RETURNING id, email
        `

        if (!admin) {
            reply.code(409).send({ error: 'CONFLICT', message: 'An account with this email already exists' })
            return
        }

        // Auto-login after signup
        const [accessToken, refreshToken] = await Promise.all([
            signAccessToken({ id: admin.id, email: admin.email, role: 'company_admin' }),
            signRefreshToken({ id: admin.id }),
        ])

        logger.info({ adminId: admin.id, email: admin.email }, 'New user signup')

        return {
            accessToken,
            refreshToken,
            admin: {
                id: admin.id,
                email: admin.email,
                role: 'company_admin',
                displayName: displayName ?? null,
            },
        }
    })

    // POST /auth/login
    app.post('/auth/login', async (req, reply) => {
        const body = LoginBody.safeParse(req.body)
        if (!body.success) {
            reply.code(400).send({ error: 'VALIDATION_ERROR', message: 'Invalid email or password format' })
            return
        }

        const { email, password } = body.data
        const [admin] = await sql<
            {
                id: string
                email: string
                password_hash: string
                role: string
                display_name: string | null
                is_active: boolean
            }[]
        >`
            SELECT id, email, password_hash, role, display_name, is_active
            FROM admins WHERE email = ${email.toLowerCase()}
        `

        if (!admin || !admin.is_active) {
            reply.code(401).send({ error: 'UNAUTHORIZED', message: 'Invalid email or password' })
            return
        }

        const valid = await verifyPassword(password, admin.password_hash)
        if (!valid) {
            reply.code(401).send({ error: 'UNAUTHORIZED', message: 'Invalid email or password' })
            return
        }

        const [accessToken, refreshToken] = await Promise.all([
            signAccessToken({ id: admin.id, email: admin.email, role: admin.role }),
            signRefreshToken({ id: admin.id }),
        ])

        await sql`UPDATE admins SET last_login_at = now() WHERE id = ${admin.id}`

        logger.info({ adminId: admin.id, email: admin.email }, 'Admin login')

        return {
            accessToken,
            refreshToken,
            admin: {
                id: admin.id,
                email: admin.email,
                role: admin.role,
                displayName: admin.display_name,
            },
        }
    })

    // POST /auth/refresh
    app.post('/auth/refresh', async (req, reply) => {
        const body = RefreshBody.safeParse(req.body)
        if (!body.success) {
            reply.code(400).send({ error: 'VALIDATION_ERROR', message: 'Missing refreshToken' })
            return
        }

        try {
            const payload = await verifyToken(body.data.refreshToken)
            if (payload.type !== 'refresh') {
                reply.code(401).send({ error: 'UNAUTHORIZED', message: 'Invalid token type' })
                return
            }

            const [admin] = await sql<{ id: string; email: string; role: string; is_active: boolean }[]>`
                SELECT id, email, role, is_active FROM admins WHERE id = ${payload.sub!}
            `
            if (!admin || !admin.is_active) {
                reply.code(401).send({ error: 'UNAUTHORIZED', message: 'Account disabled' })
                return
            }

            const [accessToken, refreshToken] = await Promise.all([
                signAccessToken({ id: admin.id, email: admin.email, role: admin.role }),
                signRefreshToken({ id: admin.id }),
            ])

            return { accessToken, refreshToken }
        } catch {
            reply.code(401).send({ error: 'UNAUTHORIZED', message: 'Invalid or expired refresh token' })
        }
    })

    // GET /auth/me — requires valid access token
    app.get('/auth/me', { preHandler: [requireAdmin] }, async (req) => {
        const identity = (req as FastifyRequest & { adminIdentity: AdminIdentity }).adminIdentity
        const [admin] = await sql<{ id: string; email: string; role: string; display_name: string | null }[]>`
                SELECT id, email, role, display_name FROM admins WHERE id = ${identity.adminId}
            `

        // Get companies this admin can access
        let companies
        if (identity.role === 'superadmin') {
            companies = await sql`
                    SELECT id, tally_company_name, erpnext_company, last_heartbeat_at
                    FROM companies ORDER BY created_at DESC
                `
        } else {
            companies = await sql`
                    SELECT c.id, c.tally_company_name, c.erpnext_company, c.last_heartbeat_at
                    FROM companies c
                    JOIN admin_company_access aca ON aca.company_id = c.id
                    WHERE aca.admin_id = ${identity.adminId}
                    ORDER BY c.created_at DESC
                `
        }

        return {
            admin: {
                id: admin!.id,
                email: admin!.email,
                role: admin!.role,
                displayName: admin!.display_name,
            },
            companies,
        }
    })
}

import type { FastifyRequest } from 'fastify'
