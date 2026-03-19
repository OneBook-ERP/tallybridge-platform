/**
 * Tests for dashboard API routes
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

const { mockSql, mockErpClient, mockAdminIdentity } = vi.hoisted(() => {
    const mockSql = Object.assign(
        vi.fn(() => Promise.resolve([])),
        { json: (v: unknown) => v },
    )
    const mockErpClient = { countDocs: vi.fn(() => Promise.resolve(0)) }
    const mockAdminIdentity = {
        adminId: 'admin-1',
        email: 'admin@test.com',
        role: 'superadmin' as const,
        companyIds: [],
    }
    return { mockSql, mockErpClient, mockAdminIdentity }
})

vi.mock('../../db/db', () => {
    const fn = (...args: unknown[]) => mockSql(...args)
    fn.json = (v: unknown) => v
    return { sql: fn }
})
vi.mock('../../erpnext/client', () => ({
    erpClient: mockErpClient,
    ERPNextClient: class MockERPNextClient {
        constructor() {}
        ensureOpeningStockEntry = vi.fn(() => Promise.resolve())
    },
}))
vi.mock('../../sync/opening-balance', () => ({
    generateOpeningBalance: vi.fn(() => Promise.resolve('JV-2024-00001')),
}))
vi.mock('../../lib/logger', () => ({
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
vi.mock('../../auth/require-admin', () => ({
    requireAdmin: async (request: Record<string, unknown>) => {
        request.adminIdentity = mockAdminIdentity
    },
    scopeCompany: (_identity: unknown, companyId?: string) => companyId || undefined,
}))

import { dashboardRoutes } from './routes'

let app: FastifyInstance

beforeEach(async () => {
    vi.clearAllMocks()
    mockSql.mockResolvedValue([])
    app = Fastify()
    await app.register(dashboardRoutes)
    await app.ready()
})

afterEach(() => app.close())

// ── GET /dashboard/companies ──────────────────────────────────────────────────

describe('GET /dashboard/companies', () => {
    it('returns companies array', async () => {
        mockSql.mockResolvedValueOnce([{ id: 'c1', tally_company_name: 'Demo Co', erpnext_company: 'Demo' }])

        const res = await app.inject({ method: 'GET', url: '/dashboard/companies' })

        expect(res.statusCode).toBe(200)
        const body = JSON.parse(res.body)
        expect(body.companies).toHaveLength(1)
        expect(body.companies[0].tally_company_name).toBe('Demo Co')
    })

    it('returns empty array when no companies', async () => {
        const res = await app.inject({ method: 'GET', url: '/dashboard/companies' })

        expect(res.statusCode).toBe(200)
        expect(JSON.parse(res.body).companies).toHaveLength(0)
    })
})

// ── GET /dashboard/stats ──────────────────────────────────────────────────────

describe('GET /dashboard/stats', () => {
    it('returns numeric stats', async () => {
        // Each query has a conditional sql fragment interpolation → 2 mock calls per query (fragment + main)
        mockSql
            .mockResolvedValueOnce([]) // fragment: sync_count WHERE
            .mockResolvedValueOnce([{ synced: '42', errored: '3', pending: '5', conflicts: '1' }]) // main: sync_count
            .mockResolvedValueOnce([]) // fragment: exc_count WHERE
            .mockResolvedValueOnce([{ open_exceptions: '7', total_exceptions: '10' }]) // main: exc_count

        const res = await app.inject({ method: 'GET', url: '/dashboard/stats?companyId=c1' })

        expect(res.statusCode).toBe(200)
        const body = JSON.parse(res.body)
        expect(body.synced).toBe(42)
        expect(body.errored).toBe(3)
        expect(body.openExceptions).toBe(7)
    })

    it('handles missing rows (defaults to 0)', async () => {
        mockSql
            .mockResolvedValueOnce([]) // fragment sync
            .mockResolvedValueOnce([]) // main sync → empty → defaults
            .mockResolvedValueOnce([]) // fragment exc
            .mockResolvedValueOnce([]) // main exc → empty → defaults

        const res = await app.inject({ method: 'GET', url: '/dashboard/stats' })

        expect(res.statusCode).toBe(200)
        const body = JSON.parse(res.body)
        expect(body.synced).toBe(0)
        expect(body.openExceptions).toBe(0)
    })

    it('works without companyId', async () => {
        mockSql
            .mockResolvedValueOnce([]) // fragment sync (sql``)
            .mockResolvedValueOnce([{ synced: '0', errored: '0', pending: '0', conflicts: '0' }])
            .mockResolvedValueOnce([]) // fragment exc
            .mockResolvedValueOnce([{ open_exceptions: '0', total_exceptions: '0' }])

        const res = await app.inject({ method: 'GET', url: '/dashboard/stats' })
        expect(res.statusCode).toBe(200)
    })
})

// ── GET /dashboard/sync-records ───────────────────────────────────────────────

describe('GET /dashboard/sync-records', () => {
    it('returns records array', async () => {
        // 3 calls: WHERE fragment, COUNT query, main SELECT
        mockSql
            .mockResolvedValueOnce([]) // WHERE fragment
            .mockResolvedValueOnce([{ total: 1 }]) // COUNT
            .mockResolvedValueOnce([
                { tally_guid: 'g1', erpnext_doctype: 'Sales Invoice', erpnext_name: 'SINV-001', sync_status: 'SYNCED' },
            ])

        const res = await app.inject({ method: 'GET', url: '/dashboard/sync-records' })

        expect(res.statusCode).toBe(200)
        const body = JSON.parse(res.body)
        expect(body.records).toHaveLength(1)
        expect(body.records[0].erpnext_doctype).toBe('Sales Invoice')
        expect(body.total).toBe(1)
    })

    it('respects limit param (max 200)', async () => {
        mockSql
            .mockResolvedValueOnce([]) // WHERE fragment
            .mockResolvedValueOnce([{ total: 0 }]) // COUNT
            .mockResolvedValueOnce([]) // SELECT
        const res = await app.inject({ method: 'GET', url: '/dashboard/sync-records?limit=300' })
        // Should not error — limit clamped to 200 internally
        expect(res.statusCode).toBe(200)
    })
})

// ── GET /dashboard/exceptions ─────────────────────────────────────────────────

describe('GET /dashboard/exceptions', () => {
    it('returns exceptions array', async () => {
        // 3 calls: WHERE fragment, COUNT query, main SELECT
        mockSql
            .mockResolvedValueOnce([]) // WHERE fragment
            .mockResolvedValueOnce([{ total: 1 }]) // COUNT
            .mockResolvedValueOnce([
                { id: 'e1', tier: 'TIER2_FLAG', error_code: 'UNMAPPED_LEDGER', error_message: 'Unknown ledger' },
            ])

        const res = await app.inject({ method: 'GET', url: '/dashboard/exceptions' })

        expect(res.statusCode).toBe(200)
        const body = JSON.parse(res.body)
        expect(body.exceptions).toHaveLength(1)
        expect(body.exceptions[0].error_code).toBe('UNMAPPED_LEDGER')
    })
})

// ── GET /dashboard/audit-log ──────────────────────────────────────────────────

describe('GET /dashboard/audit-log', () => {
    it('returns entries array', async () => {
        // Conditional sql fragment → 2 calls: fragment first, then main query
        mockSql
            .mockResolvedValueOnce([]) // fragment
            .mockResolvedValueOnce([{ id: 'a1', actor: 'system', event_type: 'SYNC', document_ref: 'SINV-001' }])

        const res = await app.inject({ method: 'GET', url: '/dashboard/audit-log' })

        expect(res.statusCode).toBe(200)
        const body = JSON.parse(res.body)
        expect(body.entries).toHaveLength(1)
        expect(body.entries[0].event_type).toBe('SYNC')
    })
})

// ── POST /dashboard/reprocess-exceptions ─────────────────────────────────────

describe('POST /dashboard/reprocess-exceptions', () => {
    it('resolves ERPNEXT_WRITE_FAILED exceptions', async () => {
        // openExceptions query
        mockSql.mockResolvedValueOnce([{ id: 'e1', error_message: 'failed', document_ref: 'Voucher:guid-001' }])
        // DELETE sync_records
        mockSql.mockResolvedValueOnce([])
        // UPDATE exception_register
        mockSql.mockResolvedValueOnce([{ id: 'e1' }])

        const res = await app.inject({
            method: 'POST',
            url: '/dashboard/reprocess-exceptions',
            payload: { companyId: 'c1', errorCode: 'ERPNEXT_WRITE_FAILED' },
        })

        expect(res.statusCode).toBe(200)
        const body = JSON.parse(res.body)
        expect(body.ok).toBe(true)
        expect(body.resolved).toBe(1)
    })

    it('no-op when no exceptions found', async () => {
        mockSql.mockResolvedValueOnce([]) // no open exceptions

        const res = await app.inject({
            method: 'POST',
            url: '/dashboard/reprocess-exceptions',
            payload: { companyId: 'c1', errorCode: 'ERPNEXT_WRITE_FAILED' },
        })

        expect(res.statusCode).toBe(200)
        expect(JSON.parse(res.body).resolved).toBe(0)
    })

    it('returns ok without companyId (global resolve)', async () => {
        mockSql.mockResolvedValueOnce([{ id: 'e1' }, { id: 'e2' }])

        const res = await app.inject({
            method: 'POST',
            url: '/dashboard/reprocess-exceptions',
            payload: {},
        })

        expect(res.statusCode).toBe(200)
        expect(JSON.parse(res.body).ok).toBe(true)
    })
})

// ── POST /dashboard/reset-sync ────────────────────────────────────────────────

describe('POST /dashboard/reset-sync', () => {
    it('clears sync_records and exceptions for company', async () => {
        const res = await app.inject({
            method: 'POST',
            url: '/dashboard/reset-sync?companyId=c1',
        })

        expect(res.statusCode).toBe(200)
        expect(JSON.parse(res.body).ok).toBe(true)
        expect(mockSql).toHaveBeenCalled()
    })

    it('includeMasters=true also clears master tables', async () => {
        const res = await app.inject({
            method: 'POST',
            url: '/dashboard/reset-sync?companyId=c1&includeMasters=true',
        })

        expect(res.statusCode).toBe(200)
        // Should have called sql more times (ledger_masters + stock_item_masters deletes)
        expect(mockSql.mock.calls.length).toBeGreaterThanOrEqual(4)
    })

    it('truncates all tables when no companyId', async () => {
        const res = await app.inject({
            method: 'POST',
            url: '/dashboard/reset-sync',
        })

        expect(res.statusCode).toBe(200)
        expect(JSON.parse(res.body).ok).toBe(true)
        const queries = mockSql.mock.calls.map((c) => c[0].join?.('?') ?? '')
        expect(queries.some((q: string) => q.includes('TRUNCATE'))).toBe(true)
    })
})

// ── POST /dashboard/reprocess-exceptions — UNMAPPED_LEDGER ──────────────────

describe('POST /dashboard/reprocess-exceptions — UNMAPPED_LEDGER', () => {
    it('resolves UNMAPPED_LEDGER when ledger now mapped', async () => {
        // Real scenario: "OFFICE RENT" was unmapped, user adds mapping, then reprocesses
        mockSql.mockResolvedValueOnce([
            { id: 'e1', error_message: 'Tally ledger "OFFICE RENT" has no mapping', document_ref: 'Voucher:guid-001' },
        ])
        // config_profiles query — mapping now exists
        mockSql.mockResolvedValueOnce([
            {
                account_mappings: { 'OFFICE RENT': '5209 - Office Rent - CPT', 'B2B SALES': '4110 - Sales - CPT' },
            },
        ])
        // UPDATE exception_register
        mockSql.mockResolvedValueOnce([{ id: 'e1' }])

        const res = await app.inject({
            method: 'POST',
            url: '/dashboard/reprocess-exceptions',
            payload: { companyId: 'c1', errorCode: 'UNMAPPED_LEDGER' },
        })

        expect(res.statusCode).toBe(200)
        const body = JSON.parse(res.body)
        expect(body.resolved).toBe(1)
        expect(body.errorCode).toBe('UNMAPPED_LEDGER')
    })

    it('does not resolve UNMAPPED_LEDGER when ledger still not mapped', async () => {
        mockSql.mockResolvedValueOnce([
            {
                id: 'e1',
                error_message: 'Tally ledger "PACKING CHARGES" has no mapping',
                document_ref: 'Voucher:guid-002',
            },
        ])
        // config_profiles — PACKING CHARGES not in mappings
        mockSql.mockResolvedValueOnce([
            {
                account_mappings: { 'B2B SALES': '4110 - Sales - CPT' },
            },
        ])

        const res = await app.inject({
            method: 'POST',
            url: '/dashboard/reprocess-exceptions',
            payload: { companyId: 'c1', errorCode: 'UNMAPPED_LEDGER' },
        })

        expect(res.statusCode).toBe(200)
        expect(JSON.parse(res.body).resolved).toBe(0)
    })

    it('defaults errorCode to UNMAPPED_LEDGER when not specified', async () => {
        mockSql.mockResolvedValueOnce([])

        const res = await app.inject({
            method: 'POST',
            url: '/dashboard/reprocess-exceptions',
            payload: { companyId: 'c1' },
        })

        expect(res.statusCode).toBe(200)
        expect(JSON.parse(res.body).errorCode).toBe('UNMAPPED_LEDGER')
    })

    it('resolves FALLBACK_TO_JOURNAL + deletes sync_records', async () => {
        mockSql.mockResolvedValueOnce([
            {
                id: 'e1',
                error_message: 'Payment fallback',
                document_ref: 'Voucher:3b4a4714-7fa1-4344-a9cf-97e8d4168385-0000abcd',
            },
        ])
        mockSql.mockResolvedValueOnce([]) // DELETE sync_records
        mockSql.mockResolvedValueOnce([{ id: 'e1' }]) // UPDATE resolved

        const res = await app.inject({
            method: 'POST',
            url: '/dashboard/reprocess-exceptions',
            payload: { companyId: 'c1', errorCode: 'FALLBACK_TO_JOURNAL' },
        })

        expect(res.statusCode).toBe(200)
        expect(JSON.parse(res.body).resolved).toBe(1)
    })
})

// ── POST /dashboard/opening-balance ─────────────────────────────────────────

describe('POST /dashboard/opening-balance', () => {
    it('generates opening balance JV', async () => {
        // Company row
        mockSql.mockResolvedValueOnce([
            {
                erpnext_company: 'Covai Polymer Traders',
                erpnext_abbr: 'CPT',
                erpnext_gstin: '33AABCZ2616B1ZV',
                erpnext_url: 'https://tally.zenpivot.in',
                erpnext_api_key: 'k',
                erpnext_api_secret: 's',
            },
        ])
        // config_profiles
        mockSql.mockResolvedValueOnce([
            {
                account_mappings: { 'HDFC BANK': '1220 - HDFC Bank - CPT' },
            },
        ])

        const res = await app.inject({
            method: 'POST',
            url: '/dashboard/opening-balance',
            payload: { companyId: 'c1', postingDate: '2023-04-01' },
        })

        expect(res.statusCode).toBe(200)
        const body = JSON.parse(res.body)
        expect(body.ok).toBe(true)
        expect(body.erpName).toBe('JV-2024-00001')
    })

    it('returns error when companyId missing', async () => {
        const res = await app.inject({
            method: 'POST',
            url: '/dashboard/opening-balance',
            payload: { postingDate: '2023-04-01' },
        })

        expect(res.statusCode).toBe(200)
        expect(JSON.parse(res.body).ok).toBe(false)
        expect(JSON.parse(res.body).error).toContain('required')
    })

    it('returns error when company not found', async () => {
        mockSql.mockResolvedValueOnce([]) // no company

        const res = await app.inject({
            method: 'POST',
            url: '/dashboard/opening-balance',
            payload: { companyId: 'nonexistent', postingDate: '2023-04-01' },
        })

        expect(res.statusCode).toBe(200)
        expect(JSON.parse(res.body).ok).toBe(false)
        expect(JSON.parse(res.body).error).toContain('not found')
    })
})

// ── POST /dashboard/opening-stock ───────────────────────────────────────────

describe('POST /dashboard/opening-stock', () => {
    it('creates opening stock entry from stock_item_masters', async () => {
        // Company row
        mockSql.mockResolvedValueOnce([
            {
                erpnext_company: 'Covai Polymer Traders',
                erpnext_abbr: 'CPT',
                erpnext_url: 'https://tally.zenpivot.in',
                erpnext_api_key: 'k',
                erpnext_api_secret: 's',
            },
        ])
        // stock_item_masters with opening quantities — real Tally data
        mockSql.mockResolvedValueOnce([
            { tally_name: 'HDPE GRANULES', opening_qty: 500, opening_value: -32500, uom: 'KGS' },
            { tally_name: 'FILLER', opening_qty: 1000, opening_value: -35000, uom: 'KGS' },
        ])

        const res = await app.inject({
            method: 'POST',
            url: '/dashboard/opening-stock',
            payload: { companyId: 'c1', postingDate: '2023-04-01' },
        })

        expect(res.statusCode).toBe(200)
        const body = JSON.parse(res.body)
        expect(body.ok).toBe(true)
        expect(body.itemCount).toBe(2)
        expect(body.warehouse).toBe('Stores - CPT')
    })

    it('returns error when no items with opening_qty > 0', async () => {
        mockSql.mockResolvedValueOnce([
            {
                erpnext_company: 'Covai Polymer Traders',
                erpnext_abbr: 'CPT',
                erpnext_url: 'https://tally.zenpivot.in',
                erpnext_api_key: 'k',
                erpnext_api_secret: 's',
            },
        ])
        mockSql.mockResolvedValueOnce([]) // no stock items

        const res = await app.inject({
            method: 'POST',
            url: '/dashboard/opening-stock',
            payload: { companyId: 'c1', postingDate: '2023-04-01' },
        })

        expect(res.statusCode).toBe(200)
        const body = JSON.parse(res.body)
        expect(body.ok).toBe(false)
        expect(body.error).toContain('No stock items')
    })

    it('returns error when companyId missing', async () => {
        const res = await app.inject({
            method: 'POST',
            url: '/dashboard/opening-stock',
            payload: { postingDate: '2023-04-01' },
        })

        expect(res.statusCode).toBe(200)
        expect(JSON.parse(res.body).ok).toBe(false)
    })

    it('uses custom warehouse if provided', async () => {
        mockSql.mockResolvedValueOnce([
            {
                erpnext_company: 'Covai Polymer Traders',
                erpnext_abbr: 'CPT',
                erpnext_url: 'https://tally.zenpivot.in',
                erpnext_api_key: 'k',
                erpnext_api_secret: 's',
            },
        ])
        mockSql.mockResolvedValueOnce([
            { tally_name: 'HDPE GRANULES', opening_qty: 500, opening_value: -32500, uom: 'KGS' },
        ])

        const res = await app.inject({
            method: 'POST',
            url: '/dashboard/opening-stock',
            payload: { companyId: 'c1', postingDate: '2023-04-01', warehouse: 'Main Store - CPT' },
        })

        expect(res.statusCode).toBe(200)
        expect(JSON.parse(res.body).warehouse).toBe('Main Store - CPT')
    })
})

// ── GET /dashboard/data-comparison ──────────────────────────────────────────

describe('GET /dashboard/data-comparison', () => {
    it('returns comparison rows + totals', async () => {
        // companies query
        mockSql.mockResolvedValueOnce([{ erpnext_company: 'Covai Polymer Traders' }])
        // sync_records GROUP BY — mirrors real sync counts
        mockSql
            .mockResolvedValueOnce([]) // fragment
            .mockResolvedValueOnce([
                { erpnext_doctype: 'Sales Invoice', count: '754' },
                { erpnext_doctype: 'Purchase Invoice', count: '228' },
                { erpnext_doctype: 'Payment Entry', count: '1577' },
                { erpnext_doctype: 'Journal Entry', count: '752' },
            ])
        // exception_register GROUP BY
        mockSql
            .mockResolvedValueOnce([]) // fragment
            .mockResolvedValueOnce([
                { error_code: 'UNMAPPED_LEDGER', count: '12' },
                { error_code: 'ERPNEXT_WRITE_FAILED', count: '3' },
            ])
        // ERPNext countDocs — real counts from tally.zenpivot.in
        mockErpClient.countDocs
            .mockResolvedValueOnce(192) // Item
            .mockResolvedValueOnce(456) // Customer
            .mockResolvedValueOnce(361) // Supplier
            .mockResolvedValueOnce(754) // Sales Invoice
            .mockResolvedValueOnce(228) // Purchase Invoice
            .mockResolvedValueOnce(752) // Journal Entry
            .mockResolvedValueOnce(1577) // Payment Entry

        const res = await app.inject({
            method: 'GET',
            url: '/dashboard/data-comparison?companyId=c1',
        })

        expect(res.statusCode).toBe(200)
        const body = JSON.parse(res.body)
        expect(body.comparison).toHaveLength(7)
        expect(body.comparison.find((c: Record<string, unknown>) => c.doctype === 'Sales Invoice').tallySynced).toBe(
            754,
        )
        expect(body.comparison.find((c: Record<string, unknown>) => c.doctype === 'Sales Invoice').erpnextCount).toBe(
            754,
        )
        expect(body.exceptions).toEqual({ UNMAPPED_LEDGER: 12, ERPNEXT_WRITE_FAILED: 3 })
        expect(body.totalTallySynced).toBe(754 + 228 + 1577 + 752)
        expect(body.totalErpNext).toBe(192 + 456 + 361 + 754 + 228 + 752 + 1577)
    })

    it('handles ERPNext count failure gracefully', async () => {
        // No companyId → no companies query needed for erpnextCompany
        // sync_records
        mockSql
            .mockResolvedValueOnce([]) // fragment
            .mockResolvedValueOnce([])
        // exceptions
        mockSql
            .mockResolvedValueOnce([]) // fragment
            .mockResolvedValueOnce([])
        // countDocs fails for some
        mockErpClient.countDocs
            .mockResolvedValueOnce(10)
            .mockRejectedValueOnce(new Error('timeout'))
            .mockResolvedValueOnce(5)
            .mockResolvedValueOnce(20)
            .mockResolvedValueOnce(8)
            .mockResolvedValueOnce(3)
            .mockResolvedValueOnce(15)

        const res = await app.inject({
            method: 'GET',
            url: '/dashboard/data-comparison',
        })

        expect(res.statusCode).toBe(200)
        const body = JSON.parse(res.body)
        // Failed count returns -1
        expect(body.comparison.find((c: Record<string, unknown>) => c.doctype === 'Customer').erpnextCount).toBe(-1)
        // totalErpNext excludes -1 values
        expect(body.totalErpNext).toBe(10 + 5 + 20 + 8 + 3 + 15)
    })
})
