/**
 * Dashboard API routes — serves data to the cloud-frontend.
 * No auth for now (internal use only during development).
 */
import type { FastifyPluginAsync } from 'fastify'
import { sql } from '../../db/db'
import { erpClient } from '../../erpnext/client'
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
        const doctypes = ['Item', 'Customer', 'Supplier', 'Sales Invoice', 'Purchase Invoice', 'Journal Entry', 'Payment Entry']
        const erpCounts: Record<string, number> = {}

        const companyFilter = erpnextCompany ? [['company', '=', erpnextCompany]] : undefined

        await Promise.all(doctypes.map(async (dt) => {
            try {
                // Masters (Item, Customer, Supplier) don't have company or custom_sync_source fields
                const isMaster = ['Item', 'Customer', 'Supplier'].includes(dt)
                const filters = isMaster ? [] : (companyFilter ?? [])
                erpCounts[dt] = await erpClient.countDocs(dt, filters.length > 0 ? filters : undefined)
            } catch (err) {
                logger.warn({ doctype: dt, err }, 'Failed to count ERPNext docs')
                erpCounts[dt] = -1 // indicates error
            }
        }))

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

        const comparison = categories.map(cat => ({
            label: cat.label,
            doctype: cat.doctype,
            tallySynced: tallyByType[cat.tallyKey] ?? 0,
            erpnextCount: erpCounts[cat.doctype] ?? 0,
        }))

        return {
            comparison,
            exceptions: exceptionsByCode,
            totalTallySynced: Object.values(tallyByType).reduce((a, b) => a + b, 0),
            totalErpNext: Object.values(erpCounts).filter(v => v >= 0).reduce((a, b) => a + b, 0),
        }
    })
}
