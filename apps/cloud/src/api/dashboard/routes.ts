/**
 * Dashboard API routes — serves data to the cloud-frontend.
 * No auth for now (internal use only during development).
 */
import type { FastifyPluginAsync } from 'fastify'
import { sql } from '../../db/db'
import { erpClient } from '../../erpnext/client'
import { generateOpeningBalance } from '../../sync/opening-balance'
import { logger } from '../../lib/logger'

export const dashboardRoutes: FastifyPluginAsync = async (app) => {
    // GET /dashboard/companies — list all registered companies
    app.get('/dashboard/companies', async () => {
        const rows = await sql`
            SELECT id, machine_id, tally_company_name, erpnext_company,
                   last_heartbeat_at, created_at
            FROM companies
            ORDER BY created_at DESC
        `
        return { companies: rows }
    })

    // GET /dashboard/stats?companyId=... — overview metrics
    app.get<{ Querystring: { companyId?: string } }>('/dashboard/stats', async (req) => {
        const { companyId } = req.query

        const [syncCount] = await sql`
            SELECT
                COUNT(*) FILTER (WHERE sync_status = 'SYNCED') AS synced,
                COUNT(*) FILTER (WHERE sync_status = 'ERROR') AS errored,
                COUNT(*) FILTER (WHERE sync_status = 'PENDING') AS pending,
                COUNT(*) FILTER (WHERE sync_status = 'CONFLICT') AS conflicts
            FROM sync_records
            ${companyId ? sql`WHERE company_id = ${companyId}` : sql``}
        `
        const [excCount] = await sql`
            SELECT
                COUNT(*) FILTER (WHERE resolved_at IS NULL) AS open_exceptions,
                COUNT(*) AS total_exceptions
            FROM exception_register
            ${companyId ? sql`WHERE company_id = ${companyId}` : sql``}
        `

        return {
            synced: Number(syncCount?.synced ?? 0),
            errored: Number(syncCount?.errored ?? 0),
            pending: Number(syncCount?.pending ?? 0),
            conflicts: Number(syncCount?.conflicts ?? 0),
            openExceptions: Number(excCount?.open_exceptions ?? 0),
            totalExceptions: Number(excCount?.total_exceptions ?? 0),
        }
    })

    // GET /dashboard/sync-records?companyId=...&limit=50 — recent sync activity
    app.get<{ Querystring: { companyId?: string; limit?: string } }>('/dashboard/sync-records', async (req) => {
        const { companyId } = req.query
        const limit = Math.min(parseInt(req.query.limit || '50', 10), 200)

        const rows = await sql`
            SELECT tally_guid, erpnext_doctype, erpnext_name, sync_status, last_synced_at
            FROM sync_records
            ${companyId ? sql`WHERE company_id = ${companyId}` : sql``}
            ORDER BY last_synced_at DESC
            LIMIT ${limit}
        `
        return { records: rows }
    })

    // GET /dashboard/exceptions?companyId=... — open exceptions
    app.get<{ Querystring: { companyId?: string } }>('/dashboard/exceptions', async (req) => {
        const { companyId } = req.query

        const rows = await sql`
            SELECT id, tier, document_ref, error_code, error_message, created_at, resolved_at
            FROM exception_register
            ${companyId ? sql`WHERE company_id = ${companyId}` : sql``}
            ORDER BY created_at DESC
            LIMIT 100
        `
        return { exceptions: rows }
    })

    // GET /dashboard/audit-log?companyId=...&limit=50 — recent audit entries
    app.get<{ Querystring: { companyId?: string; limit?: string } }>('/dashboard/audit-log', async (req) => {
        const { companyId } = req.query
        const limit = Math.min(parseInt(req.query.limit || '50', 10), 200)

        const rows = await sql`
            SELECT id, actor, event_type, document_ref, created_at
            FROM audit_log
            ${companyId ? sql`WHERE company_id = ${companyId}` : sql``}
            ORDER BY created_at DESC
            LIMIT ${limit}
        `
        return { entries: rows }
    })

    // POST /dashboard/reprocess-exceptions — resolve open exceptions that now have mappings
    app.post<{ Body: { companyId?: string; errorCode?: string } }>('/dashboard/reprocess-exceptions', async (req) => {
        const { companyId, errorCode } = req.body ?? {}
        const code = errorCode ?? 'UNMAPPED_LEDGER'

        // Get the account mappings for the company
        let resolvedCount = 0
        if (companyId) {
            const [profile] = await sql<{ account_mappings: Record<string, string> }[]>`
                    SELECT account_mappings FROM config_profiles WHERE company_id = ${companyId}
                `
            const mappings = profile?.account_mappings ?? {}

            // Find open exceptions matching the error code
            const openExceptions = await sql<{ id: string; error_message: string; document_ref: string }[]>`
                    SELECT id, error_message, document_ref FROM exception_register
                    WHERE company_id = ${companyId}
                      AND error_code = ${code}
                      AND resolved_at IS NULL
                `

            const toResolve: string[] = []
            for (const exc of openExceptions) {
                // Extract ledger name from error_message: 'Tally ledger "X" has no...'
                const match = exc.error_message.match(/Tally ledger "([^"]+)"/)
                const ledgerName = match?.[1]
                if (ledgerName && mappings[ledgerName]) {
                    toResolve.push(exc.id)
                }
            }

            if (toResolve.length > 0) {
                await sql`
                        UPDATE exception_register
                        SET resolved_at = now(), resolved_by = 'system:reprocess'
                        WHERE id = ANY(${toResolve})
                    `
                resolvedCount = toResolve.length
            }

            logger.info(
                { companyId, code, total: openExceptions.length, resolved: resolvedCount },
                'Reprocessed exceptions',
            )
        } else {
            // No companyId — bulk resolve all that match
            const result = await sql`
                    UPDATE exception_register
                    SET resolved_at = now(), resolved_by = 'system:reprocess'
                    WHERE error_code = ${code} AND resolved_at IS NULL
                    RETURNING id
                `
            resolvedCount = result.length
        }

        return { ok: true, resolved: resolvedCount, errorCode: code }
    })

    // POST /dashboard/opening-balance — generate opening balance Journal Entry from Tally ledger masters
    app.post<{ Body: { companyId: string; postingDate: string } }>('/dashboard/opening-balance', async (req) => {
        const { companyId, postingDate } = req.body ?? {}
        if (!companyId || !postingDate) {
            return { ok: false, error: 'companyId and postingDate are required' }
        }

        // Load company + config
        const [company] = await sql<{
            erpnext_company: string
            erpnext_abbr: string | null
            erpnext_url: string
            erpnext_api_key: string
            erpnext_api_secret: string
        }[]>`
            SELECT erpnext_company, erpnext_abbr, erpnext_url, erpnext_api_key, erpnext_api_secret
            FROM companies WHERE id = ${companyId}
        `
        if (!company) return { ok: false, error: 'Company not found' }

        const [profile] = await sql<{ account_mappings: Record<string, string> }[]>`
            SELECT account_mappings FROM config_profiles WHERE company_id = ${companyId}
        `

        try {
            const erpName = await generateOpeningBalance({
                companyId,
                erpnextCompany: company.erpnext_company,
                erpnextAbbr: company.erpnext_abbr ?? undefined,
                postingDate,
                accountMappings: profile?.account_mappings ?? {},
                costCenter: `Main - ${company.erpnext_abbr ?? 'CPT'}`,
                companyGstin: '33AABCZ2616B1ZV',
                erpnextUrl: company.erpnext_url,
                erpnextApiKey: company.erpnext_api_key,
                erpnextApiSecret: company.erpnext_api_secret,
            })
            return { ok: true, erpName }
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            return { ok: false, error: msg }
        }
    })

    // GET /dashboard/data-comparison?companyId=... — Tally vs ERPNext document counts
    app.get<{ Querystring: { companyId?: string } }>('/dashboard/data-comparison', async (req) => {
        const { companyId } = req.query

        // Get company details for ERPNext filtering
        let erpnextCompany: string | null = null
        if (companyId) {
            const [co] = await sql`SELECT erpnext_company FROM companies WHERE id = ${companyId}`
            erpnextCompany = co?.erpnext_company ?? null
        }

        // Tally side: count vouchers synced to cloud by type (from sync_records)
        const tallyCounts = await sql`
            SELECT erpnext_doctype, count(*) as count
            FROM sync_records
            ${companyId ? sql`WHERE company_id = ${companyId}` : sql``}
            GROUP BY erpnext_doctype
        `
        const tallyByType: Record<string, number> = {}
        for (const row of tallyCounts) {
            tallyByType[row.erpnext_doctype] = Number(row.count)
        }

        // Also count exceptions (failed syncs) by voucher type from exception_register
        const exceptionCounts = await sql`
            SELECT error_code, count(*) as count
            FROM exception_register
            ${companyId ? sql`WHERE company_id = ${companyId} AND resolved_at IS NULL` : sql`WHERE resolved_at IS NULL`}
            GROUP BY error_code
        `
        const exceptionsByCode: Record<string, number> = {}
        for (const row of exceptionCounts) {
            exceptionsByCode[row.error_code] = Number(row.count)
        }

        // ERPNext side: count documents by doctype
        const doctypes = [
            'Item',
            'Customer',
            'Supplier',
            'Sales Invoice',
            'Purchase Invoice',
            'Journal Entry',
            'Payment Entry',
        ]
        const erpCounts: Record<string, number> = {}

        const companyFilter = erpnextCompany ? [['company', '=', erpnextCompany]] : undefined

        await Promise.all(
            doctypes.map(async (dt) => {
                try {
                    // Masters (Item, Customer, Supplier) don't have company or custom_sync_source fields
                    const isMaster = ['Item', 'Customer', 'Supplier'].includes(dt)
                    const filters = isMaster ? [] : (companyFilter ?? [])
                    erpCounts[dt] = await erpClient.countDocs(dt, filters.length > 0 ? filters : undefined)
                } catch (err) {
                    logger.warn({ doctype: dt, err }, 'Failed to count ERPNext docs')
                    erpCounts[dt] = -1 // indicates error
                }
            }),
        )

        // Build comparison rows
        const categories = [
            { label: 'Items', doctype: 'Item', tallyKey: 'Item' },
            { label: 'Customers', doctype: 'Customer', tallyKey: 'Customer' },
            { label: 'Suppliers', doctype: 'Supplier', tallyKey: 'Supplier' },
            { label: 'Sales Invoices', doctype: 'Sales Invoice', tallyKey: 'Sales Invoice' },
            { label: 'Purchase Invoices', doctype: 'Purchase Invoice', tallyKey: 'Purchase Invoice' },
            { label: 'Journal Entries', doctype: 'Journal Entry', tallyKey: 'Journal Entry' },
            { label: 'Payment Entries', doctype: 'Payment Entry', tallyKey: 'Payment Entry' },
        ]

        const comparison = categories.map((cat) => ({
            label: cat.label,
            doctype: cat.doctype,
            tallySynced: tallyByType[cat.tallyKey] ?? 0,
            erpnextCount: erpCounts[cat.doctype] ?? 0,
        }))

        return {
            comparison,
            exceptions: exceptionsByCode,
            totalTallySynced: Object.values(tallyByType).reduce((a, b) => a + b, 0),
            totalErpNext: Object.values(erpCounts)
                .filter((v) => v >= 0)
                .reduce((a, b) => a + b, 0),
        }
    })
}
