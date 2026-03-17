/**
 * PUT /connector/config
 *
 * The connector calls this to push its locally-configured mappings and
 * ERPNext credentials to the cloud, so the sync engine has everything it needs.
 *
 * Auth: Bearer machineToken
 * Body: { accountMappings, gstLedgerMappings, voucherTypeMappings,
 *          erpnextUrl, erpnextApiKey, erpnextApiSecret, erpnextCompany }
 */
import type { FastifyPluginAsync, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { requireConnectorAuth, type ConnectorIdentity } from '../../auth/machine-tokens'
import { sql } from '../../db/db'
import { logger } from '../../lib/logger'

const ConfigBodySchema = z.object({
    companyId: z.string().uuid(),
    accountMappings: z.record(z.unknown()).optional(),
    gstLedgerMappings: z.record(z.unknown()).optional(),
    voucherTypeMappings: z.record(z.unknown()).optional(),
    erpnextUrl: z.string().url().optional(),
    erpnextApiKey: z.string().optional(),
    erpnextApiSecret: z.string().optional(),
    erpnextCompany: z.string().optional(),
    erpnextGstin: z.string().optional(),
    erpnextWarehouse: z.string().optional(),
    erpnextCostCenter: z.string().optional(),
})

/** Strip meta keys like _type and entries with empty/falsy values */
function stripMetaKeys(obj: Record<string, unknown>): Record<string, unknown> {
    const clean: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(obj)) {
        if (k.startsWith('_')) continue
        if (v === '' || v === null || v === undefined) continue
        clean[k] = v
    }
    return clean
}

/** Normalize GST ledger mapping keys to snake_case format expected by the engine.
 *  Accepts display names like "Output Tax CGST" → "output_cgst" */
function normalizeGSTKeys(raw: Record<string, unknown>): Record<string, string> {
    const GST_KEY_MAP: Record<string, string> = {
        output_cgst: 'output_cgst',
        output_sgst: 'output_sgst',
        output_igst: 'output_igst',
        input_cgst: 'input_cgst',
        input_sgst: 'input_sgst',
        input_igst: 'input_igst',
    }
    const result: Record<string, string> = {}
    for (const [k, v] of Object.entries(raw)) {
        if (k.startsWith('_')) continue
        const val = typeof v === 'string' ? v : ''
        if (!val) continue // skip empty values
        // Already snake_case?
        if (GST_KEY_MAP[k]) {
            result[k] = val
            continue
        }
        // Try to detect from display name: "Output Tax CGST" → output_cgst
        const lower = k.toLowerCase()
        const isOutput = lower.includes('output') || lower.includes('sales')
        const isInput = lower.includes('input') || lower.includes('purchase')
        const direction = isInput ? 'input' : isOutput ? 'output' : null
        if (!direction) {
            result[k] = val
            continue
        }
        if (lower.includes('cgst')) result[`${direction}_cgst`] = val
        else if (lower.includes('sgst') || lower.includes('utgst')) result[`${direction}_sgst`] = val
        else if (lower.includes('igst')) result[`${direction}_igst`] = val
        else result[k] = val
    }
    return result
}

type AuthedRequest = FastifyRequest & { connectorIdentity?: ConnectorIdentity }

export const configRoute: FastifyPluginAsync = async (fastify) => {
    fastify.put<{ Body: z.infer<typeof ConfigBodySchema> }>(
        '/connector/config',
        { preHandler: [requireConnectorAuth] },
        async (request: AuthedRequest, reply) => {
            const body = ConfigBodySchema.parse(request.body)

            if (request.connectorIdentity?.companyId !== body.companyId) {
                return reply.code(403).send({ error: 'FORBIDDEN', message: 'Token/companyId mismatch' })
            }

            // Update config_profiles — MERGE incoming values with existing ones.
            // Strip _type meta keys injected by UI defaults, normalize GST keys.
            // Uses JSONB || operator to merge: existing keys are preserved,
            // incoming keys are added or updated (never deleted).
            const accountMappings = stripMetaKeys(body.accountMappings ?? {}) as Record<string, string>
            const gstLedgerMappings = normalizeGSTKeys(body.gstLedgerMappings ?? {})
            const voucherTypeMappings = stripMetaKeys(body.voucherTypeMappings ?? {})

            if (Object.keys(accountMappings).length > 0) {
                await sql`UPDATE config_profiles SET account_mappings = account_mappings || ${sql.json(accountMappings)}::jsonb WHERE company_id = ${body.companyId}`
            }
            if (Object.keys(gstLedgerMappings).length > 0) {
                await sql`UPDATE config_profiles SET gst_ledger_mappings = gst_ledger_mappings || ${sql.json(gstLedgerMappings)}::jsonb WHERE company_id = ${body.companyId}`
            }
            if (Object.keys(voucherTypeMappings).length > 0) {
                await sql`UPDATE config_profiles SET voucher_type_mappings = voucher_type_mappings || ${sql.json(voucherTypeMappings as Record<string, string>)}::jsonb WHERE company_id = ${body.companyId}`
            }

            // Update companies with ERPNext connection details
            if (
                body.erpnextUrl ||
                body.erpnextApiKey ||
                body.erpnextApiSecret ||
                body.erpnextCompany ||
                body.erpnextGstin ||
                body.erpnextWarehouse ||
                body.erpnextCostCenter
            ) {
                await sql`
                    UPDATE companies SET
                        erpnext_url         = COALESCE(${body.erpnextUrl ?? null}, erpnext_url),
                        erpnext_api_key     = COALESCE(${body.erpnextApiKey ?? null}, erpnext_api_key),
                        erpnext_api_secret  = COALESCE(${body.erpnextApiSecret ?? null}, erpnext_api_secret),
                        erpnext_company     = COALESCE(${body.erpnextCompany ?? null}, erpnext_company),
                        erpnext_gstin       = COALESCE(${body.erpnextGstin ?? null}, erpnext_gstin),
                        erpnext_warehouse   = COALESCE(${body.erpnextWarehouse ?? null}, erpnext_warehouse),
                        erpnext_cost_center = COALESCE(${body.erpnextCostCenter ?? null}, erpnext_cost_center)
                    WHERE id = ${body.companyId}
                `
            }

            logger.info({ companyId: body.companyId }, 'Connector config updated')
            return reply.send({ ok: true })
        },
    )
}
