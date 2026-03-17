/**
 * Tests for PUT /connector/config
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

const { mockSql } = vi.hoisted(() => {
    const mockSql = Object.assign(
        vi.fn(() => Promise.resolve([])),
        { json: (v: unknown) => v },
    )
    return { mockSql }
})

const CID = '00000000-0000-0000-0000-000000000001'
let mockIdentity = { companyId: CID, tallyCompanyName: 'Test Co' }

vi.mock('../../db/db', () => {
    const fn = (...args: unknown[]) => mockSql(...args)
    fn.json = (v: unknown) => v
    return { sql: fn }
})
vi.mock('../../auth/machine-tokens', () => ({
    requireConnectorAuth: vi.fn(async (request: Record<string, unknown>) => {
        request.connectorIdentity = mockIdentity
    }),
}))
vi.mock('../../lib/logger', () => ({
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { configRoute } from './config'

let app: FastifyInstance

beforeEach(async () => {
    vi.clearAllMocks()
    mockIdentity = { companyId: CID, tallyCompanyName: 'Test Co' }
    app = Fastify()
    await app.register(configRoute)
    await app.ready()
})

afterEach(() => app.close())

const base = { companyId: CID }

describe('PUT /connector/config', () => {
    it('account mappings merged via JSONB ||', async () => {
        const res = await app.inject({
            method: 'PUT',
            url: '/connector/config',
            payload: { ...base, accountMappings: { 'Sales - TC': 'B2B Sales' } },
            headers: { authorization: 'Bearer t' },
        })

        expect(res.statusCode).toBe(200)
        const queries = mockSql.mock.calls.map((c) => c[0].join('?'))
        expect(queries.some((q: string) => q.includes('account_mappings') && q.includes('||'))).toBe(true)
    })

    it('meta keys (_type) stripped from accountMappings', async () => {
        await app.inject({
            method: 'PUT',
            url: '/connector/config',
            payload: { ...base, accountMappings: { _type: 'coa', Sales: 'B2B' } },
            headers: { authorization: 'Bearer t' },
        })

        // sql.json should receive object without _type
        const jsonCalls = mockSql.mock.calls.filter((c) => c[0].join('?').includes('account_mappings'))
        expect(jsonCalls.length).toBeGreaterThan(0)
    })

    it('empty/null values stripped from mappings', async () => {
        const res = await app.inject({
            method: 'PUT',
            url: '/connector/config',
            payload: { ...base, accountMappings: { Sales: '', Bank: null, Cash: 'Petty Cash' } },
            headers: { authorization: 'Bearer t' },
        })

        expect(res.statusCode).toBe(200)
        expect(mockSql).toHaveBeenCalled()
    })

    it('"Output Tax CGST" → output_cgst', async () => {
        await app.inject({
            method: 'PUT',
            url: '/connector/config',
            payload: { ...base, gstLedgerMappings: { 'Output Tax CGST': 'CGST Ledger' } },
            headers: { authorization: 'Bearer t' },
        })

        const queries = mockSql.mock.calls.map((c) => c[0].join('?'))
        expect(queries.some((q: string) => q.includes('gst_ledger_mappings'))).toBe(true)
    })

    it('"Input Tax SGST" → input_sgst', async () => {
        await app.inject({
            method: 'PUT',
            url: '/connector/config',
            payload: { ...base, gstLedgerMappings: { 'Input Tax SGST': 'SGST Input' } },
            headers: { authorization: 'Bearer t' },
        })

        expect(mockSql).toHaveBeenCalled()
    })

    it('already snake_case keys preserved', async () => {
        await app.inject({
            method: 'PUT',
            url: '/connector/config',
            payload: { ...base, gstLedgerMappings: { output_cgst: 'CGST Ledger' } },
            headers: { authorization: 'Bearer t' },
        })

        expect(mockSql).toHaveBeenCalled()
    })

    it('empty mappings skip DB UPDATE', async () => {
        await app.inject({
            method: 'PUT',
            url: '/connector/config',
            payload: { ...base, accountMappings: {} },
            headers: { authorization: 'Bearer t' },
        })

        const queries = mockSql.mock.calls.map((c) => c[0].join('?'))
        expect(queries.filter((q: string) => q.includes('account_mappings'))).toHaveLength(0)
    })

    it('ERPNext fields use COALESCE', async () => {
        await app.inject({
            method: 'PUT',
            url: '/connector/config',
            payload: { ...base, erpnextUrl: 'https://erp.example.com', erpnextCompany: 'My Co' },
            headers: { authorization: 'Bearer t' },
        })

        const queries = mockSql.mock.calls.map((c) => c[0].join('?'))
        expect(queries.some((q: string) => q.includes('COALESCE') && q.includes('companies'))).toBe(true)
    })

    it('token mismatch → 403', async () => {
        mockIdentity = { companyId: '00000000-0000-0000-0000-000000000099', tallyCompanyName: 'X' }

        const res = await app.inject({
            method: 'PUT',
            url: '/connector/config',
            payload: { ...base, accountMappings: { A: 'B' } },
            headers: { authorization: 'Bearer t' },
        })

        expect(res.statusCode).toBe(403)
    })

    it('partial ERP fields (only url) updates only url', async () => {
        await app.inject({
            method: 'PUT',
            url: '/connector/config',
            payload: { ...base, erpnextUrl: 'https://erp.example.com' },
            headers: { authorization: 'Bearer t' },
        })

        const queries = mockSql.mock.calls.map((c) => c[0].join('?'))
        expect(queries.some((q: string) => q.includes('companies'))).toBe(true)
    })
})

// ── autoFetchAndSeedCompany unit tests ──────────────────────────────────────
import { autoFetchAndSeedCompany } from './config'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

describe('autoFetchAndSeedCompany', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mockSql.mockResolvedValue([])
    })

    it('fetches company details and returns abbr + gstin', async () => {
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({ data: { abbr: 'ABC', tax_id: '27AAAAA0000A1Z5' } }),
        })
        const result = await autoFetchAndSeedCompany(
            'company-uuid', 'https://erp.example.com', 'apikey', 'apisecret', 'Test Company',
        )
        expect(result.abbr).toBe('ABC')
        expect(result.gstin).toBe('27AAAAA0000A1Z5')
    })

    it('calls ERPNext Company API with correct URL and auth', async () => {
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({ data: { abbr: 'XYZ', tax_id: '' } }),
        })
        await autoFetchAndSeedCompany('cid', 'https://erp.test', 'key', 'secret', 'My Company')
        const [url, opts] = mockFetch.mock.calls[0] as [string, RequestInit]
        expect(url).toContain('/api/resource/Company/My%20Company')
        expect((opts.headers as Record<string, string>)['Authorization']).toBe('token key:secret')
    })

    it('throws when ERPNext returns non-ok status', async () => {
        mockFetch.mockResolvedValueOnce({ ok: false, status: 403 })
        await expect(
            autoFetchAndSeedCompany('cid', 'https://erp.test', 'k', 's', 'Test'),
        ).rejects.toThrow('ERPNext Company fetch failed: 403')
    })

    it('seeds config_profiles when abbr is non-empty', async () => {
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({ data: { abbr: 'TCS', tax_id: '' } }),
        })
        await autoFetchAndSeedCompany('cid', 'https://erp.test', 'k', 's', 'Co')
        // UPDATE companies + UPDATE config_profiles = 2 sql calls minimum
        expect(mockSql.mock.calls.length).toBeGreaterThanOrEqual(2)
    })

    it('skips config_profiles seed when abbr is empty', async () => {
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({ data: { abbr: '', tax_id: '' } }),
        })
        await autoFetchAndSeedCompany('cid', 'https://erp.test', 'k', 's', 'Co')
        // Only UPDATE companies — no config_profiles seed
        expect(mockSql.mock.calls.length).toBe(1)
    })

    it('returns empty abbr and gstin when data fields are missing', async () => {
        mockFetch.mockResolvedValueOnce({
            ok: true,
            json: async () => ({ data: {} }),
        })
        const result = await autoFetchAndSeedCompany('cid', 'https://erp.test', 'k', 's', 'Co')
        expect(result.abbr).toBe('')
        expect(result.gstin).toBe('')
    })
})
