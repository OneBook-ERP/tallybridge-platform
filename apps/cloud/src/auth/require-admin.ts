/**
 * Fastify preHandler — validates JWT and attaches admin identity to request.
 * Follows the same pattern as requireConnectorAuth in machine-tokens.ts.
 */
import type { FastifyRequest, FastifyReply } from 'fastify'
import { verifyToken } from './admin-auth'
import { sql } from '../db/db'
import { ForbiddenError } from '../lib/errors'

export interface AdminIdentity {
    adminId: string
    email: string
    role: 'superadmin' | 'company_admin'
    companyIds: string[] // empty = all (superadmin)
}

export async function requireAdmin(
    request: FastifyRequest & { adminIdentity?: AdminIdentity },
    reply: FastifyReply,
): Promise<void> {
    const auth = request.headers.authorization
    if (!auth || !auth.startsWith('Bearer ')) {
        reply.code(401).send({ error: 'UNAUTHORIZED', message: 'Missing Bearer token' })
        return
    }

    const token = auth.slice(7)
    try {
        const payload = await verifyToken(token)
        if (payload.type !== 'access') {
            reply.code(401).send({ error: 'UNAUTHORIZED', message: 'Invalid token type' })
            return
        }

        // Check admin exists and is active
        const [admin] = await sql<{ id: string; email: string; role: string; is_active: boolean }[]>`
            SELECT id, email, role, is_active FROM admins WHERE id = ${payload.sub!}
        `
        if (!admin || !admin.is_active) {
            reply.code(401).send({ error: 'UNAUTHORIZED', message: 'Admin account disabled or not found' })
            return
        }

        // Get company access for non-superadmins
        let companyIds: string[] = []
        if (admin.role === 'company_admin') {
            const rows = await sql<{ company_id: string }[]>`
                SELECT company_id FROM admin_company_access WHERE admin_id = ${admin.id}
            `
            companyIds = rows.map((r) => r.company_id)
        }

        request.adminIdentity = {
            adminId: admin.id,
            email: admin.email,
            role: admin.role as AdminIdentity['role'],
            companyIds,
        }
    } catch {
        reply.code(401).send({ error: 'UNAUTHORIZED', message: 'Invalid or expired token' })
    }
}

/**
 * Validates that an admin has access to the requested companyId.
 * Superadmins have access to all companies.
 * Returns the companyId filter or null (meaning all).
 */
export function scopeCompany(identity: AdminIdentity, requestedCompanyId?: string): string | undefined {
    if (identity.role === 'superadmin') {
        return requestedCompanyId || undefined
    }

    if (requestedCompanyId) {
        if (!identity.companyIds.includes(requestedCompanyId)) {
            throw new ForbiddenError('You do not have access to this company')
        }
        return requestedCompanyId
    }

    // No specific company requested — return first if single, undefined if multiple
    if (identity.companyIds.length === 1) {
        return identity.companyIds[0]
    }
    return undefined
}
