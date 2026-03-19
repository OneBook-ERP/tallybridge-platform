/**
 * Dashboard API routes — serves data to the cloud-frontend.
 * Protected by JWT auth — all routes require a valid admin token.
 */
import type { FastifyPluginAsync, FastifyRequest } from 'fastify'
import { sql } from '../../db/db'
import { erpClient, ERPNextClient } from '../../erpnext/client'
import { generateOpeningBalance } from '../../sync/opening-balance'
import { logger } from '../../lib/logger'
import { requireAdmin, scopeCompany, type AdminIdentity } from '../../auth/require-admin'
import { buildDefaultMappings } from '../../transform/default-mappings'

type AuthedRequest = FastifyRequest & { adminIdentity: AdminIdentity }

export const dashboardRoutes: FastifyPluginAsync = async (app) => {
    // Protect all dashboard routes with JWT auth
    app.addHook('preHandler', requireAdmin)

    // GET /dashboard/companies — list companies the admin can access
    app.get('/dashboard/companies', async (req) => {
        const identity = (req as AuthedRequest).adminIdentity

        let rows
        if (identity.role === 'superadmin') {
            rows = await sql`
                SELECT id, machine_id, tally_company_name, erpnext_company,
                       last_heartbeat_at, created_at
                FROM companies
                ORDER BY created_at DESC
            `
        } else {
            rows = await sql`
                SELECT c.id, c.machine_id, c.tally_company_name, c.erpnext_company,
                       c.last_heartbeat_at, c.created_at
                FROM companies c
                JOIN admin_company_access aca ON aca.company_id = c.id
                WHERE aca.admin_id = ${identity.adminId}
                ORDER BY c.created_at DESC
            `
        }
        return { companies: rows }
    })

    // GET /dashboard/stats?companyId=... — overview metrics
    app.get<{ Querystring: { companyId?: string } }>('/dashboard/stats', async (req) => {
        const identity = (req as AuthedRequest).adminIdentity
        const companyId = scopeCompany(identity, req.query.companyId)

        const [syncCount] = await sql`
            SELECT
                COUNT(*) FILTER (WHERE sync_status = 'SYNCED') AS synced,
                COUNT(*) FILTER (WHERE sync_status = 'ERROR') AS errored,
                COUNT(*) FILTER (WHERE sync_status = 'PENDING') AS pending,
                COUNT(*) FILTER (WHERE sync_status = 'CONFLICT') AS conflicts
            FROM sync_records
            ${companyId ? sql`WHERE company_id = ${companyId}` : identity.companyIds.length > 0 ? sql`WHERE company_id = ANY(${identity.companyIds})` : sql``}
        `
        const [excCount] = await sql`
            SELECT
                COUNT(*) FILTER (WHERE resolved_at IS NULL) AS open_exceptions,
                COUNT(*) AS total_exceptions
            FROM exception_register
            ${companyId ? sql`WHERE company_id = ${companyId}` : identity.companyIds.length > 0 ? sql`WHERE company_id = ANY(${identity.companyIds})` : sql``}
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
    app.get<{ Querystring: { companyId?: string; limit?: string; offset?: string } }>(
        '/dashboard/sync-records',
        async (req) => {
            const identity = (req as AuthedRequest).adminIdentity
            const companyId = scopeCompany(identity, req.query.companyId)
            const limit = Math.min(parseInt(req.query.limit || '50', 10), 200)
            const offset = Math.max(parseInt(req.query.offset || '0', 10), 0)

            const whereClause = companyId
                ? sql`WHERE company_id = ${companyId}`
                : identity.companyIds.length > 0
                  ? sql`WHERE company_id = ANY(${identity.companyIds})`
                  : sql``

            const [{ total }] = await sql<
                { total: number }[]
            >`SELECT COUNT(*)::int AS total FROM sync_records ${whereClause}`

            const rows = await sql`
            SELECT tally_guid, erpnext_doctype, erpnext_name, sync_status, last_synced_at
            FROM sync_records
            ${whereClause}
            ORDER BY last_synced_at DESC
            LIMIT ${limit} OFFSET ${offset}
        `
            return { records: rows, total }
        },
    )

    // GET /dashboard/exceptions?companyId=...&limit=50&offset=0 — paginated exceptions
    app.get<{ Querystring: { companyId?: string; limit?: string; offset?: string } }>(
        '/dashboard/exceptions',
        async (req) => {
            const identity = (req as AuthedRequest).adminIdentity
            const companyId = scopeCompany(identity, req.query.companyId)
            const limit = Math.min(parseInt(req.query.limit || '50', 10), 200)
            const offset = Math.max(parseInt(req.query.offset || '0', 10), 0)

            const whereClause = companyId
                ? sql`WHERE company_id = ${companyId}`
                : identity.companyIds.length > 0
                  ? sql`WHERE company_id = ANY(${identity.companyIds})`
                  : sql``

            const [{ total }] = await sql<{ total: number }[]>`
            SELECT COUNT(*)::int AS total FROM exception_register ${whereClause}
        `
            const rows = await sql`
            SELECT id, tier, document_ref, error_code, error_message, created_at, resolved_at
            FROM exception_register ${whereClause}
            ORDER BY created_at DESC
            LIMIT ${limit} OFFSET ${offset}
        `
            return { exceptions: rows, total, limit, offset }
        },
    )

    // GET /dashboard/audit-log?companyId=...&limit=50 — recent audit entries
    app.get<{ Querystring: { companyId?: string; limit?: string } }>('/dashboard/audit-log', async (req) => {
        const identity = (req as AuthedRequest).adminIdentity
        const companyId = scopeCompany(identity, req.query.companyId)
        const limit = Math.min(parseInt(req.query.limit || '50', 10), 200)

        const rows = await sql`
            SELECT id, actor, event_type, document_ref, created_at
            FROM audit_log
            ${companyId ? sql`WHERE company_id = ${companyId}` : identity.companyIds.length > 0 ? sql`WHERE company_id = ANY(${identity.companyIds})` : sql``}
            ORDER BY created_at DESC
            LIMIT ${limit}
        `
        return { entries: rows }
    })

    // POST /dashboard/reprocess-exceptions — clear sync_records for failed vouchers so the
    // connector re-syncs them on next cycle, and mark exceptions as resolved.
    // For FALLBACK_TO_JOURNAL + ERPNEXT_WRITE_FAILED: we delete the sync_record so the
    // connector will re-push the voucher, which now routes correctly.
    // For UNMAPPED_LEDGER: only resolve if the ledger is now mapped.
    app.post<{ Body: { companyId?: string; errorCode?: string } }>('/dashboard/reprocess-exceptions', async (req) => {
        const identity = (req as AuthedRequest).adminIdentity
        const { errorCode } = req.body ?? {}
        const companyId = scopeCompany(identity, (req.body as { companyId?: string })?.companyId)
        const code = errorCode ?? 'UNMAPPED_LEDGER'

        let resolvedCount = 0
        const retryableCodes = ['FALLBACK_TO_JOURNAL', 'ERPNEXT_WRITE_FAILED', 'MASTER_CREATE_FAILED']

        if (companyId) {
            const openExceptions = await sql<{ id: string; error_message: string; document_ref: string }[]>`
                SELECT id, error_message, document_ref FROM exception_register
                WHERE company_id = ${companyId}
                  AND error_code = ${code}
                  AND resolved_at IS NULL
            `

            if (retryableCodes.includes(code)) {
                // Extract GUIDs from document_ref = 'Voucher:{guid}'
                const guids = openExceptions.map((e) => e.document_ref.replace(/^Voucher:/, '')).filter(Boolean)

                if (guids.length > 0) {
                    // Delete sync_records so the connector re-sends on next sync
                    await sql`
                        DELETE FROM sync_records
                        WHERE company_id = ${companyId}
                          AND tally_guid = ANY(${guids})
                    `
                }
                // Mark all as resolved
                const ids = openExceptions.map((e) => e.id)
                if (ids.length > 0) {
                    await sql`
                        UPDATE exception_register
                        SET resolved_at = now(), resolved_by = 'system:reprocess'
                        WHERE id = ANY(${ids})
                    `
                    resolvedCount = ids.length
                }
            } else {
                // UNMAPPED_LEDGER: only resolve if mapping now exists
                const [profile] = await sql<{ account_mappings: Record<string, string> }[]>`
                    SELECT account_mappings FROM config_profiles WHERE company_id = ${companyId}
                `
                const mappings = profile?.account_mappings ?? {}
                const toResolve: string[] = []
                for (const exc of openExceptions) {
                    const match = exc.error_message.match(/Tally ledger "([^"]+)"/)
                    const ledgerName = match?.[1]
                    if (ledgerName && mappings[ledgerName]) toResolve.push(exc.id)
                }
                if (toResolve.length > 0) {
                    await sql`
                        UPDATE exception_register
                        SET resolved_at = now(), resolved_by = 'system:reprocess'
                        WHERE id = ANY(${toResolve})
                    `
                    resolvedCount = toResolve.length
                }
            }

            logger.info(
                { companyId, code, total: openExceptions.length, resolved: resolvedCount },
                'Reprocessed exceptions',
            )
        } else {
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
        const identity = (req as AuthedRequest).adminIdentity
        const { postingDate } = req.body ?? {}
        const companyId = scopeCompany(identity, (req.body as { companyId?: string })?.companyId)
        if (!companyId || !postingDate) {
            return { ok: false, error: 'companyId and postingDate are required' }
        }

        // Load company + config
        const [company] = await sql<
            {
                erpnext_company: string
                erpnext_abbr: string | null
                erpnext_gstin: string | null
                erpnext_url: string
                erpnext_api_key: string
                erpnext_api_secret: string
            }[]
        >`
            SELECT erpnext_company, erpnext_abbr, erpnext_gstin, erpnext_url, erpnext_api_key, erpnext_api_secret
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
                costCenter: company.erpnext_abbr ? `Main - ${company.erpnext_abbr}` : undefined,
                companyGstin: company.erpnext_gstin ?? undefined,
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

    // POST /dashboard/opening-stock — create Opening Stock Reconciliation in ERPNext from stock_item_masters
    app.post<{ Body: { companyId: string; postingDate: string; warehouse?: string } }>(
        '/dashboard/opening-stock',
        async (req) => {
            const identity = (req as AuthedRequest).adminIdentity
            const { postingDate, warehouse } = req.body ?? {}
            const companyId = scopeCompany(identity, (req.body as { companyId?: string })?.companyId)
            if (!companyId || !postingDate) {
                return { ok: false, error: 'companyId and postingDate are required' }
            }

            const [company] = await sql<
                {
                    erpnext_company: string
                    erpnext_abbr: string | null
                    erpnext_url: string
                    erpnext_api_key: string
                    erpnext_api_secret: string
                }[]
            >`
            SELECT erpnext_company, erpnext_abbr, erpnext_url, erpnext_api_key, erpnext_api_secret
            FROM companies WHERE id = ${companyId}
        `
            if (!company) return { ok: false, error: 'Company not found' }

            const abbr =
                company.erpnext_abbr ??
                company.erpnext_company
                    .split(' ')
                    .map((w: string) => w[0])
                    .join('')
                    .toUpperCase()
                    .slice(0, 3)
            const resolvedWarehouse = warehouse ?? `Stores - ${abbr}`

            const openingRows = await sql<
                { tally_name: string; opening_qty: number; opening_value: number; uom: string | null }[]
            >`
            SELECT tally_name, opening_qty, opening_value, uom
            FROM stock_item_masters
            WHERE company_id = ${companyId} AND opening_qty > 0
        `

            if (openingRows.length === 0) {
                return { ok: false, error: 'No stock items with opening_qty > 0 found in stock_item_masters' }
            }

            const { ERPNextClient } = await import('../../erpnext/client')
            const client = new ERPNextClient({
                baseUrl: company.erpnext_url,
                apiKey: company.erpnext_api_key,
                apiSecret: company.erpnext_api_secret,
            })

            try {
                await client.ensureOpeningStockEntry(
                    openingRows.map((r) => ({
                        itemCode: r.tally_name,
                        qty: Number(r.opening_qty),
                        // Tally stores OPENINGVALUE as negative (credit convention) — use abs for valuation rate
                        rate: r.opening_qty > 0 ? Math.abs(Number(r.opening_value)) / Number(r.opening_qty) : 0,
                        uom: r.uom ?? 'Nos',
                    })),
                    company.erpnext_company,
                    resolvedWarehouse,
                    postingDate,
                )
                return { ok: true, itemCount: openingRows.length, warehouse: resolvedWarehouse }
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err)
                return { ok: false, error: msg }
            }
        },
    )

    // GET /dashboard/data-comparison?companyId=... — Tally vs ERPNext document counts
    // POST /dashboard/reset-sync?companyId=...&includeMasters=true — clears sync history but keeps config/mappings
    // Masters (ledger_masters, stock_item_masters) are only cleared when includeMasters=true
    app.post<{ Querystring: { companyId?: string; includeMasters?: string } }>('/dashboard/reset-sync', async (req) => {
        const identity = (req as AuthedRequest).adminIdentity
        const companyId = scopeCompany(identity, req.query.companyId)
        const { includeMasters } = req.query
        const clearMasters = includeMasters === 'true'
        if (companyId) {
            await sql`DELETE FROM sync_records      WHERE company_id = ${companyId}`
            await sql`DELETE FROM exception_register WHERE company_id = ${companyId}`
            if (clearMasters) {
                await sql`DELETE FROM ledger_masters    WHERE company_id = ${companyId}`
                await sql`DELETE FROM stock_item_masters WHERE company_id = ${companyId}`
            }
        } else {
            await sql`TRUNCATE sync_records, exception_register`
            if (clearMasters) {
                await sql`TRUNCATE ledger_masters, stock_item_masters`
            }
        }
        // audit_log is immutable so we skip it
        logger.info({ companyId, clearMasters }, 'Sync history reset via dashboard')
        return { ok: true }
    })

    // DELETE /dashboard/company?companyId=... — permanently delete a company and all its data
    app.delete<{ Querystring: { companyId: string } }>('/dashboard/company', async (req, reply) => {
        const identity = (req as AuthedRequest).adminIdentity
        const companyId = scopeCompany(identity, req.query.companyId)
        if (!companyId) return reply.status(400).send({ error: 'companyId is required' })

        // Delete all child tables explicitly, then the company row.
        // Use individual awaited queries (not transaction — audit_log trigger needs special handling).
        const tables = [
            'sync_records', 'exception_register', 'conflict_log', 'job_log',
            'config_profiles', 'ledger_masters', 'stock_item_masters',
            'godown_warehouse_mapping', 'voucher_type_mapping', 'admin_company_access',
        ]
        for (const table of tables) {
            await sql.unsafe(`DELETE FROM ${table} WHERE company_id = $1`, [companyId])
        }
        // audit_log: immutable trigger blocks DELETE — disable, delete, re-enable
        await sql`ALTER TABLE audit_log DISABLE TRIGGER trg_audit_log_immutable`
        await sql.unsafe(`DELETE FROM audit_log WHERE company_id = $1`, [companyId])
        await sql`ALTER TABLE audit_log ENABLE TRIGGER trg_audit_log_immutable`
        // Finally the company row
        await sql`DELETE FROM companies WHERE id = ${companyId}`

        logger.info({ companyId }, 'Company deleted via dashboard')
        return { ok: true }
    })

    app.get<{ Querystring: { companyId?: string } }>('/dashboard/data-comparison', async (req) => {
        const identity = (req as AuthedRequest).adminIdentity
        const companyId = scopeCompany(identity, req.query.companyId)

        // Get company details for ERPNext filtering and Tally-side counts (from heartbeat)
        let erpnextCompany: string | null = null
        let tallyCountsRaw: Record<string, number> | null = null
        let tallyCountsUpdatedAt: string | null = null
        let companyErpClient = erpClient // fallback to singleton
        if (companyId) {
            const [co] = await sql<
                {
                    erpnext_company: string
                    erpnext_url: string | null
                    erpnext_api_key: string | null
                    erpnext_api_secret: string | null
                    tally_counts: Record<string, number> | null
                    last_heartbeat_at: string | null
                }[]
            >`SELECT erpnext_company, erpnext_url, erpnext_api_key, erpnext_api_secret,
                     tally_counts, last_heartbeat_at FROM companies WHERE id = ${companyId}`
            erpnextCompany = co?.erpnext_company ?? null
            tallyCountsRaw = co?.tally_counts ?? null
            tallyCountsUpdatedAt = co?.last_heartbeat_at ?? null
            // Use per-company ERPNext credentials when available
            if (co?.erpnext_url && co?.erpnext_api_key && co?.erpnext_api_secret) {
                companyErpClient = new ERPNextClient({
                    baseUrl: co.erpnext_url,
                    apiKey: co.erpnext_api_key,
                    apiSecret: co.erpnext_api_secret,
                })
            }
        }

        // Tally side: count vouchers synced to cloud by type (from sync_records)
        const syncedRows = await sql`
            SELECT erpnext_doctype, count(*) as count
            FROM sync_records
            ${companyId ? sql`WHERE company_id = ${companyId}` : sql``}
            GROUP BY erpnext_doctype
        `
        const tallyByType: Record<string, number> = {}
        for (const row of syncedRows) {
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
                    erpCounts[dt] = await companyErpClient.countDocs(dt, filters.length > 0 ? filters : undefined)
                } catch (err) {
                    logger.warn({ doctype: dt, err }, 'Failed to count ERPNext docs')
                    erpCounts[dt] = -1 // indicates error
                }
            }),
        )

        // Helper: resolve tallyCount from tally_counts JSONB stored via heartbeat.
        // Keys come from GetVoucherCounts ("Sales","Purchase","Payment","Receipt","Journal")
        // and GetMasterCounts ("Sundry Debtors","Sundry Creditors","stockItems").
        function resolveTallyCount(doctype: string): number | null {
            if (!tallyCountsRaw) return null
            const tc = tallyCountsRaw
            switch (doctype) {
                case 'Sales Invoice':
                    return (tc['Sales'] ?? tc['Sales Invoice'] ?? null) as number | null
                case 'Purchase Invoice':
                    return (tc['Purchase'] ?? tc['Purchase Invoice'] ?? null) as number | null
                case 'Payment Entry': {
                    const pay = (tc['Payment'] ?? 0) as number
                    const rec = (tc['Receipt'] ?? 0) as number
                    return pay + rec > 0 ? pay + rec : ((tc['Payment Entry'] ?? null) as number | null)
                }
                case 'Journal Entry':
                    return (tc['Journal'] ?? tc['Journal Entry'] ?? null) as number | null
                case 'Item':
                    return (tc['stockItems'] ?? tc['Stock Item'] ?? null) as number | null
                case 'Customer':
                    // GetMasterCounts uses "Sundry Debtors" as the key (the actual Tally group name)
                    return (tc['Sundry Debtors'] ?? tc['Trade Debtors'] ?? null) as number | null
                case 'Supplier':
                    return (tc['Sundry Creditors'] ?? tc['Trade Creditors'] ?? null) as number | null
                default:
                    return null
            }
        }

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
            tallyCount: resolveTallyCount(cat.doctype),
        }))

        return {
            comparison,
            exceptions: exceptionsByCode,
            totalTallySynced: Object.values(tallyByType).reduce((a, b) => a + b, 0),
            totalErpNext: Object.values(erpCounts)
                .filter((v) => v >= 0)
                .reduce((a, b) => a + b, 0),
            tallyCountsRaw,
            tallyCountsUpdatedAt,
        }
    })

    // GET /dashboard/config — return current config_profiles + godown mappings for a company
    app.get<{ Querystring: { companyId?: string } }>('/dashboard/config', async (req) => {
        const identity = (req as AuthedRequest).adminIdentity
        const companyId = scopeCompany(identity, req.query.companyId)

        if (!companyId) {
            return { accountMappings: {}, gstLedgerMappings: {}, voucherTypeMappings: {}, godownWarehouseMappings: {} }
        }

        const [companyRow] = await sql<{ erpnext_abbr: string | null }[]>`
            SELECT erpnext_abbr FROM companies WHERE id = ${companyId}
        `

        const [profile] = await sql<
            {
                account_mappings: Record<string, string> | null
                gst_ledger_mappings: Record<string, string> | null
                voucher_type_mappings: Record<string, unknown> | null
            }[]
        >`
            SELECT account_mappings, gst_ledger_mappings, voucher_type_mappings
            FROM config_profiles
            WHERE company_id = ${companyId}
        `

        const godownRows = await sql<{ tally_godown: string; erpnext_warehouse: string | null }[]>`
            SELECT tally_godown, erpnext_warehouse
            FROM godown_warehouse_mapping
            WHERE company_id = ${companyId}
            ORDER BY tally_godown
        `
        const godownWarehouseMappings: Record<string, string> = {}
        for (const row of godownRows) {
            if (row.erpnext_warehouse) godownWarehouseMappings[row.tally_godown] = row.erpnext_warehouse
        }

        const abbr = companyRow?.erpnext_abbr ?? ''
        const { groupDefaultMappings } = buildDefaultMappings(abbr)

        return {
            abbr,
            accountMappings: profile?.account_mappings ?? {},
            gstLedgerMappings: profile?.gst_ledger_mappings ?? {},
            voucherTypeMappings: profile?.voucher_type_mappings ?? {},
            godownWarehouseMappings,
            groupDefaultMappings,
        }
    })

    // PATCH /dashboard/config — merge mappings and/or upsert godown→warehouse pairs
    app.patch<{
        Body: {
            companyId?: string
            accountMappings?: Record<string, string>
            gstLedgerMappings?: Record<string, string>
            voucherTypeMappings?: Record<string, unknown>
            godownWarehouseMappings?: Record<string, string>
        }
    }>('/dashboard/config', async (req, reply) => {
        const identity = (req as AuthedRequest).adminIdentity
        const body = req.body ?? {}
        const companyId = scopeCompany(identity, body.companyId)
        if (!companyId) {
            return reply.code(400).send({ error: 'VALIDATION_ERROR', message: 'companyId is required' })
        }

        if (body.accountMappings && Object.keys(body.accountMappings).length > 0) {
            await sql`
                UPDATE config_profiles
                SET account_mappings = account_mappings || ${sql.json(body.accountMappings)}::jsonb
                WHERE company_id = ${companyId}
            `
        }
        if (body.gstLedgerMappings && Object.keys(body.gstLedgerMappings).length > 0) {
            await sql`
                UPDATE config_profiles
                SET gst_ledger_mappings = gst_ledger_mappings || ${sql.json(body.gstLedgerMappings)}::jsonb
                WHERE company_id = ${companyId}
            `
        }
        if (body.voucherTypeMappings && Object.keys(body.voucherTypeMappings).length > 0) {
            await sql`
                UPDATE config_profiles
                SET voucher_type_mappings = voucher_type_mappings || ${sql.json(body.voucherTypeMappings as Record<string, string>)}::jsonb
                WHERE company_id = ${companyId}
            `
        }
        if (body.godownWarehouseMappings) {
            for (const [tallyGodown, erpnextWarehouse] of Object.entries(body.godownWarehouseMappings)) {
                await sql`
                    INSERT INTO godown_warehouse_mapping (company_id, tally_godown, erpnext_warehouse)
                    VALUES (${companyId}, ${tallyGodown}, ${erpnextWarehouse})
                    ON CONFLICT (company_id, tally_godown)
                    DO UPDATE SET erpnext_warehouse = EXCLUDED.erpnext_warehouse
                `
            }
        }

        logger.info({ companyId }, 'Dashboard config patched')
        return reply.send({ ok: true, updated: companyId })
    })

    // GET /dashboard/godowns — list discovered godowns with optional warehouse mapping
    app.get<{ Querystring: { companyId?: string } }>('/dashboard/godowns', async (req) => {
        const identity = (req as AuthedRequest).adminIdentity
        const companyId = scopeCompany(identity, req.query.companyId)

        const rows = await sql<{ tally_godown: string; erpnext_warehouse: string | null }[]>`
            SELECT tally_godown, erpnext_warehouse
            FROM godown_warehouse_mapping
            ${companyId ? sql`WHERE company_id = ${companyId}` : sql`WHERE TRUE`}
            ORDER BY tally_godown
        `

        return {
            godowns: rows.map((r) => ({
                tallyGodown: r.tally_godown,
                erpnextWarehouse: r.erpnext_warehouse,
                mapped: r.erpnext_warehouse !== null,
            })),
        }
    })

    // ── Admin Management (superadmin only) ────────────────────────────────────

    // GET /dashboard/admins — list all admins
    app.get('/dashboard/admins', async (req, reply) => {
        const identity = (req as AuthedRequest).adminIdentity
        if (identity.role !== 'superadmin') {
            reply.code(403).send({ error: 'FORBIDDEN', message: 'Superadmin only' })
            return
        }

        const admins = await sql`
            SELECT a.id, a.email, a.display_name, a.role, a.is_active, a.last_login_at, a.created_at,
                   COALESCE(
                       json_agg(json_build_object('id', c.id, 'name', c.tally_company_name))
                       FILTER (WHERE c.id IS NOT NULL), '[]'
                   ) AS companies
            FROM admins a
            LEFT JOIN admin_company_access aca ON aca.admin_id = a.id
            LEFT JOIN companies c ON c.id = aca.company_id
            GROUP BY a.id
            ORDER BY a.created_at DESC
        `
        return { admins }
    })

    // POST /dashboard/admins — create a new admin
    app.post<{
        Body: { email: string; password: string; displayName?: string; role: string; companyIds?: string[] }
    }>('/dashboard/admins', async (req, reply) => {
        const identity = (req as AuthedRequest).adminIdentity
        if (identity.role !== 'superadmin') {
            reply.code(403).send({ error: 'FORBIDDEN', message: 'Superadmin only' })
            return
        }

        const { email, password, displayName, role, companyIds } = req.body ?? ({} as Record<string, unknown>)
        if (!email || !password || !role) {
            reply.code(400).send({ error: 'VALIDATION_ERROR', message: 'email, password, and role are required' })
            return
        }
        if (!['superadmin', 'company_admin'].includes(role)) {
            reply.code(400).send({ error: 'VALIDATION_ERROR', message: 'role must be superadmin or company_admin' })
            return
        }

        const { hashPassword } = await import('../../auth/admin-auth')
        const passwordHash = await hashPassword(password)

        const [admin] = await sql<{ id: string; email: string }[]>`
            INSERT INTO admins (email, password_hash, role, display_name)
            VALUES (${(email as string).toLowerCase()}, ${passwordHash}, ${role}, ${displayName ?? null})
            ON CONFLICT (email) DO NOTHING
            RETURNING id, email
        `

        if (!admin) {
            reply.code(409).send({ error: 'CONFLICT', message: 'Email already exists' })
            return
        }

        // Assign companies
        if (companyIds && Array.isArray(companyIds)) {
            for (const cid of companyIds) {
                await sql`
                    INSERT INTO admin_company_access (admin_id, company_id)
                    VALUES (${admin.id}, ${cid})
                    ON CONFLICT DO NOTHING
                `
            }
        }

        logger.info({ adminId: admin.id, email: admin.email, role }, 'Admin created via dashboard')
        return { ok: true, admin: { id: admin.id, email: admin.email } }
    })

    // PUT /dashboard/admins/:id — update admin
    app.put<{
        Params: { id: string }
        Body: { displayName?: string; role?: string; isActive?: boolean; password?: string; companyIds?: string[] }
    }>('/dashboard/admins/:id', async (req, reply) => {
        const identity = (req as AuthedRequest).adminIdentity
        if (identity.role !== 'superadmin') {
            reply.code(403).send({ error: 'FORBIDDEN', message: 'Superadmin only' })
            return
        }

        const { id } = req.params
        const { displayName, role, isActive, password, companyIds } = req.body ?? ({} as Record<string, unknown>)

        // Build SET clause dynamically
        const sets: string[] = []
        const values: unknown[] = []

        if (displayName !== undefined) {
            sets.push('display_name')
            values.push(displayName)
        }
        if (role !== undefined) {
            if (!['superadmin', 'company_admin'].includes(role as string)) {
                reply.code(400).send({ error: 'VALIDATION_ERROR', message: 'Invalid role' })
                return
            }
            sets.push('role')
            values.push(role)
        }
        if (isActive !== undefined) {
            sets.push('is_active')
            values.push(isActive)
        }
        if (password) {
            const { hashPassword } = await import('../../auth/admin-auth')
            sets.push('password_hash')
            values.push(await hashPassword(password as string))
        }

        if (sets.length > 0) {
            // Use individual updates since postgres.js tagged templates don't support dynamic SET
            if (displayName !== undefined)
                await sql`UPDATE admins SET display_name = ${displayName as string}, updated_at = now() WHERE id = ${id}`
            if (role !== undefined)
                await sql`UPDATE admins SET role = ${role as string}, updated_at = now() WHERE id = ${id}`
            if (isActive !== undefined)
                await sql`UPDATE admins SET is_active = ${isActive as boolean}, updated_at = now() WHERE id = ${id}`
            if (password) {
                const { hashPassword } = await import('../../auth/admin-auth')
                const hash = await hashPassword(password as string)
                await sql`UPDATE admins SET password_hash = ${hash}, updated_at = now() WHERE id = ${id}`
            }
        }

        // Update company access
        if (companyIds !== undefined && Array.isArray(companyIds)) {
            await sql`DELETE FROM admin_company_access WHERE admin_id = ${id}`
            for (const cid of companyIds) {
                await sql`
                    INSERT INTO admin_company_access (admin_id, company_id)
                    VALUES (${id}, ${cid})
                    ON CONFLICT DO NOTHING
                `
            }
        }

        logger.info({ adminId: id }, 'Admin updated via dashboard')
        return { ok: true }
    })

    // DELETE /dashboard/admins/:id — delete admin
    app.delete<{ Params: { id: string } }>('/dashboard/admins/:id', async (req, reply) => {
        const identity = (req as AuthedRequest).adminIdentity
        if (identity.role !== 'superadmin') {
            reply.code(403).send({ error: 'FORBIDDEN', message: 'Superadmin only' })
            return
        }

        const { id } = req.params
        if (id === identity.adminId) {
            reply.code(400).send({ error: 'VALIDATION_ERROR', message: 'Cannot delete your own account' })
            return
        }

        await sql`DELETE FROM admins WHERE id = ${id}`
        logger.info({ adminId: id }, 'Admin deleted via dashboard')
        return { ok: true }
    })
}
