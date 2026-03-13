/**
 * Machine token auth for the connector.
 *
 * Flow:
 *  1. Connector POSTs /connector/register → gets back a machineToken (opaque random string)
 *  2. Cloud stores SHA-256(machineToken) in companies.machine_token_hash
 *  3. All subsequent connector requests use: Authorization: Bearer <machineToken>
 *  4. Cloud hashes the incoming token and compares against DB — O(1) token lookup
 *
 * We do NOT use JWTs for machine tokens. The token is opaque; the truth lives in the DB.
 * This lets us revoke any connector instantly by nulling machine_token_hash.
 */
import { sql } from '../db/db'
import { generateToken, hashToken } from '../lib/crypto'
import { UnauthorizedError } from '../lib/errors'

export interface ConnectorIdentity {
    companyId: string
    tallyCompanyName: string
}

/**
 * Issue a new machine token for a connector registration.
 * Returns the raw token (sent to connector once, never stored).
 * Stores the hash in the companies table.
 */
export async function issueMachineToken(companyId: string): Promise<string> {
    const token = generateToken(32) // 256-bit random
    const hash = hashToken(token)

    await sql`
    UPDATE companies
    SET machine_token_hash = ${hash}
    WHERE id = ${companyId}
  `
    return token
}

/**
 * Verify a Bearer token from a connector request.
 * Returns the ConnectorIdentity if valid, throws UnauthorizedError if not.
 */
export async function verifyMachineToken(token: string): Promise<ConnectorIdentity> {
    const hash = hashToken(token)

    const [row] = await sql<{ id: string; tally_company_name: string }[]>`
    SELECT id, tally_company_name
    FROM companies
    WHERE machine_token_hash = ${hash}
  `
    if (!row) {
        throw new UnauthorizedError('Invalid or revoked machine token')
    }
    return { companyId: row.id, tallyCompanyName: row.tally_company_name }
}

/**
 * Fastify preHandler — call this on every connector route.
 * Attaches identity to request for downstream use.
 *
 * Usage in a route:
 *   preHandler: [requireConnectorAuth],
 */
import type { FastifyRequest, FastifyReply } from 'fastify'

export async function requireConnectorAuth(
    request: FastifyRequest & { connectorIdentity?: ConnectorIdentity },
    reply: FastifyReply
): Promise<void> {
    const auth = request.headers.authorization
    if (!auth || !auth.startsWith('Bearer ')) {
        reply.code(401).send({ error: 'UNAUTHORIZED', message: 'Missing Bearer token' })
        return
    }
    const token = auth.slice(7)
    try {
        request.connectorIdentity = await verifyMachineToken(token)
    } catch {
        reply.code(401).send({ error: 'UNAUTHORIZED', message: 'Invalid machine token' })
        return
    }
}
