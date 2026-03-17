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
import { buildDefaultMappings } from '../../transform/default-mappings'

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

/**
 * Fetch ERPNext Company document to get abbr + gstin, store them in companies,
 * then seed default GST + voucher type mappings into config_profiles if they are empty.
 * Called async after PUT /connector/config — does not block the response.
 */
export async function autoFetchAndSeedCompany(
    companyId: string,
    erpnextUrl: string,
    apiKey: string,
    apiSecret: string,
    erpnextCompany: string,
): Promise<{ abbr: string; gstin: string }> {
    // Fetch company document from ERPNext
    const res = await fetch(
        `${erpnextUrl}/api/resource/Company/${encodeURIComponent(erpnextCompany)}?fields=["abbr","tax_id","default_currency","country"]`,
        {
            headers: {
                Authorization: `token ${apiKey}:${apiSecret}`,
                'Content-Type': 'application/json',
            },
        },
    )
    if (!res.ok) throw new Error(`ERPNext Company fetch failed: ${res.status}`)
    const json = (await res.json()) as { data?: { abbr?: string; tax_id?: string } }
    const abbr = json.data?.abbr ?? ''
    const gstin = json.data?.tax_id ?? ''

    // Persist abbr + gstin into companies (only if not already set)
    await sql`
        UPDATE companies SET
            erpnext_abbr  = CASE WHEN erpnext_abbr  IS NULL OR erpnext_abbr  = '' THEN ${abbr}  ELSE erpnext_abbr  END,
            erpnext_gstin = CASE WHEN erpnext_gstin IS NULL OR erpnext_gstin = '' THEN ${gstin} ELSE erpnext_gstin END
        WHERE id = ${companyId}
    `

    // Seed default GST + voucher type mappings if the columns are still empty/null.
    // This gives new companies working defaults without any manual configuration.
    if (abbr) {
        const defaults = buildDefaultMappings(abbr)
        await sql`
            UPDATE config_profiles SET
                gst_ledger_mappings   = CASE
                    WHEN gst_ledger_mappings   IS NULL OR gst_ledger_mappings   = '{}'::jsonb
                    THEN ${sql.json(defaults.gstLedgerMappings)}::jsonb
                    ELSE gst_ledger_mappings
                END,
                voucher_type_mappings = CASE
                    WHEN voucher_type_mappings IS NULL OR voucher_type_mappings = '{}'::jsonb
                    THEN ${sql.json(defaults.voucherTypeMappings)}::jsonb
                    ELSE voucher_type_mappings
                END
            WHERE company_id = ${companyId}
        `
        logger.info({ companyId, abbr, gstin }, 'Auto-seeded default mappings from ERPNext company details')
    }

    return { abbr, gstin }
}

export const configRoute: FastifyPluginAsync = async (fastify) => {
    // GET /connector/config — read mappings for the connector's company
    fastify.get<{ Querystring: { companyId: string } }>(
        '/connector/config',
        { preHandler: [requireConnectorAuth] },
        async (request: AuthedRequest, reply) => {
            const companyId = request.connectorIdentity?.companyId
            if (!companyId) {
                return reply.code(403).send({ error: 'FORBIDDEN', message: 'No company identity' })
            }

            const [profile] = await sql<
                {
                    account_mappings: Record<string, string>
                    gst_ledger_mappings: Record<string, string>
                    voucher_type_mappings: Record<string, unknown>
                }[]
            >`
                SELECT account_mappings, gst_ledger_mappings, voucher_type_mappings
                FROM config_profiles WHERE company_id = ${companyId}
            `

            const godownRows = await sql<{ tally_godown: string; erpnext_warehouse: string }[]>`
                SELECT tally_godown, erpnext_warehouse
                FROM godown_warehouse_mapping
                WHERE company_id = ${companyId}
                  AND erpnext_warehouse IS NOT NULL
            `
            const godownWarehouseMappings: Record<string, string> = {}
            for (const row of godownRows) {
                godownWarehouseMappings[row.tally_godown] = row.erpnext_warehouse
            }

            return reply.send({
                accountMappings: profile?.account_mappings ?? {},
                gstLedgerMappings: profile?.gst_ledger_mappings ?? {},
                voucherTypeMappings: profile?.voucher_type_mappings ?? {},
                godownWarehouseMappings,
            })
        },
    )

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

                // Auto-fetch ERPNext company details (abbr, gstin) and seed defaults.
                // Awaited so the connector can immediately call GET /connector/config
                // and receive the seeded GST + voucher type mappings in the same cycle.
                const url = body.erpnextUrl
                const key = body.erpnextApiKey
                const secret = body.erpnextApiSecret
                const company = body.erpnextCompany
                if (url && key && secret && company) {
                    try {
                        await autoFetchAndSeedCompany(body.companyId, url, key, secret, company)
                    } catch (err) {
                        logger.warn({ companyId: body.companyId, err }, 'Auto-fetch ERPNext company details failed')
                    }
                }
            }

            logger.info({ companyId: body.companyId }, 'Connector config updated')
            return reply.send({ ok: true })
        },
    )
}
