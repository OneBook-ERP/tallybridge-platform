/**
 * Tests for POST /webhook/erpnext
 *
 * Mirrors actual system behavior:
 * - ERPNext fires webhook on doc submit/cancel/amend
 * - Cloud fetches full doc from ERPNext, transforms to Tally format, enqueues tally-write job
 * - Loop guard prevents re-processing docs created by TallyBridge itself
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

const { mockSql, mockEnqueueTallyWrite, mockGetDoc } = vi.hoisted(() => {
    const mockSql = Object.assign(
        vi.fn(() => Promise.resolve([])),
        { json: (v: unknown) => v },
    )
    const mockEnqueueTallyWrite = vi.fn(() => Promise.resolve())
    const mockGetDoc = vi.fn(() =>
        Promise.resolve({
            name: 'SINV-001',
            doctype: 'Sales Invoice',
            company: 'Test Co',
            customer: 'Cust A',
            grand_total: 1000,
            items: [{ item_code: 'Item1', qty: 1, rate: 1000, amount: 1000 }],
            taxes: [],
        }),
    )
    return { mockSql, mockEnqueueTallyWrite, mockGetDoc }
})

vi.mock('../../db/db', () => {
    const fn = (...args: unknown[]) => mockSql(...args)
    fn.json = (v: unknown) => v
    return { sql: fn }
})
vi.mock('../../erpnext/client', () => ({
    ERPNextClient: class MockERPNextClient {
        constructor() {}
        getDoc = (...args: unknown[]) => mockGetDoc(...args)
    },
}))
vi.mock('../../queue/producer', () => ({
    enqueueTallyWrite: (...args: unknown[]) => mockEnqueueTallyWrite(...args),
}))
vi.mock('../../transform/erp-to-tally/sales', () => ({
    erpSalesToTally: vi.fn(() => ({ voucherType: 'Sales', ledgerEntries: [] })),
}))
vi.mock('../../transform/erp-to-tally/purchase', () => ({
    erpPurchaseToTally: vi.fn(() => ({ voucherType: 'Purchase', ledgerEntries: [] })),
}))
vi.mock('../../transform/erp-to-tally/payment', () => ({
    erpPaymentToTally: vi.fn(() => ({ voucherType: 'Receipt', ledgerEntries: [] })),
}))
vi.mock('../../transform/erp-to-tally/journal', () => ({
    erpJournalToTally: vi.fn(() => ({ voucherType: 'Journal', ledgerEntries: [] })),
}))
vi.mock('../../lib/logger', () => ({
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { erpnextWebhookRoute } from './erpnext'

const CID = '00000000-0000-0000-0000-000000000001'
const company = {
    id: CID,
    erpnext_url: 'https://erp.test',
    erpnext_api_key: 'k',
    erpnext_api_secret: 's',
    erpnext_company: 'Test Co',
    machine_token_hash: 'h',
    machine_id: 'mid',
}
const profile = {
    account_mappings: {},
    gst_ledger_mappings: {},
    voucher_type_mappings: {},
    conflict_strategy: { default: 'TALLY_WINS' },
}

let app: FastifyInstance

function setupCompaniesAndProfile() {
    mockSql.mockReset()
    mockSql.mockImplementation((strings: TemplateStringsArray) => {
        const q = Array.isArray(strings) ? strings.join('?') : String(strings)
        if (q.includes('companies')) return Promise.resolve([company])
        if (q.includes('config_profiles')) return Promise.resolve([profile])
        return Promise.resolve([])
    })
}

beforeEach(async () => {
    vi.clearAllMocks()
    setupCompaniesAndProfile()
    mockGetDoc.mockResolvedValue({
        name: 'SINV-001',
        doctype: 'Sales Invoice',
        company: 'Test Co',
        customer: 'Cust A',
        grand_total: 1000,
        items: [{ item_code: 'Item1', qty: 1, rate: 1000, amount: 1000 }],
        taxes: [],
    })
    app = Fastify()
    await app.register(erpnextWebhookRoute)
    await app.ready()
})

afterEach(() => app.close())

describe('POST /webhook/erpnext', () => {
    it('on_submit → action=CREATE, enqueues tally-write', async () => {
        const res = await app.inject({
            method: 'POST',
            url: '/webhook/erpnext',
            payload: { doctype: 'Sales Invoice', name: 'SINV-001', event: 'on_submit' },
        })
        expect(res.statusCode).toBe(200)
        const body = JSON.parse(res.body)
        expect(body.action).toBe('CREATE')
        expect(mockEnqueueTallyWrite).toHaveBeenCalledWith(
            expect.objectContaining({ action: 'CREATE', companyId: CID }),
        )
    })

    it('on_cancel → action=CANCEL', async () => {
        const res = await app.inject({
            method: 'POST',
            url: '/webhook/erpnext',
            payload: { doctype: 'Sales Invoice', name: 'SINV-001', event: 'on_cancel' },
        })
        expect(JSON.parse(res.body).action).toBe('CANCEL')
    })

    it('on_update_after_submit → action=ALTER', async () => {
        const res = await app.inject({
            method: 'POST',
            url: '/webhook/erpnext',
            payload: { doctype: 'Sales Invoice', name: 'SINV-001', event: 'on_update_after_submit' },
        })
        expect(JSON.parse(res.body).action).toBe('ALTER')
    })

    it('unsupported doctype → skipped', async () => {
        const res = await app.inject({
            method: 'POST',
            url: '/webhook/erpnext',
            payload: { doctype: 'Asset', name: 'AST-001', event: 'on_submit' },
        })
        expect(JSON.parse(res.body).skipped).toBe(true)
        expect(mockEnqueueTallyWrite).not.toHaveBeenCalled()
    })

    it('loop guard: body custom_sync_source=TALLYBRIDGE → skipped', async () => {
        const res = await app.inject({
            method: 'POST',
            url: '/webhook/erpnext',
            payload: {
                doctype: 'Sales Invoice',
                name: 'SINV-001',
                event: 'on_submit',
                custom_sync_source: 'TALLYBRIDGE',
            },
        })
        expect(JSON.parse(res.body).skipped).toBe(true)
        expect(JSON.parse(res.body).reason).toContain('loop guard')
    })

    it('loop guard: fetched doc custom_sync_source → skipped', async () => {
        mockGetDoc.mockResolvedValueOnce({
            name: 'SINV-001',
            doctype: 'Sales Invoice',
            company: 'Test Co',
            custom_sync_source: 'TALLYBRIDGE',
        })
        const res = await app.inject({
            method: 'POST',
            url: '/webhook/erpnext',
            payload: { doctype: 'Sales Invoice', name: 'SINV-001', event: 'on_submit' },
        })
        expect(JSON.parse(res.body).skipped).toBe(true)
    })

    it('invalid body → 400', async () => {
        const res = await app.inject({
            method: 'POST',
            url: '/webhook/erpnext',
            payload: { invalid: true },
        })
        expect(res.statusCode).toBe(400)
    })

    it('no companies with ERP config → skipped', async () => {
        mockSql.mockReset()
        mockSql.mockResolvedValue([])
        const res = await app.inject({
            method: 'POST',
            url: '/webhook/erpnext',
            payload: { doctype: 'Sales Invoice', name: 'SINV-001', event: 'on_submit' },
        })
        expect(JSON.parse(res.body).skipped).toBe(true)
    })

    it('ERPNext fetch failure → 500', async () => {
        mockGetDoc.mockRejectedValueOnce(new Error('Network error'))
        const res = await app.inject({
            method: 'POST',
            url: '/webhook/erpnext',
            payload: { doctype: 'Sales Invoice', name: 'SINV-001', event: 'on_submit' },
        })
        expect(res.statusCode).toBe(500)
    })

    it('tallyGuid fallback to ERP-{name}', async () => {
        mockGetDoc.mockResolvedValueOnce({
            name: 'SINV-002',
            doctype: 'Sales Invoice',
            company: 'Test Co',
            items: [],
            taxes: [],
        })
        const res = await app.inject({
            method: 'POST',
            url: '/webhook/erpnext',
            payload: { doctype: 'Sales Invoice', name: 'SINV-002', event: 'on_submit' },
        })
        expect(JSON.parse(res.body).tallyGuid).toBe('ERP-SINV-002')
    })

    it('company matched case-insensitively', async () => {
        // ERPNext doc has company "Covai Polymer Traders" but DB row has "COVAI POLYMER TRADERS"
        mockSql.mockReset()
        const upperCompany = { ...company, erpnext_company: 'COVAI POLYMER TRADERS' }
        mockSql.mockImplementation((strings: TemplateStringsArray) => {
            const q = Array.isArray(strings) ? strings.join('?') : String(strings)
            if (q.includes('companies')) return Promise.resolve([upperCompany])
            if (q.includes('config_profiles')) return Promise.resolve([profile])
            return Promise.resolve([])
        })
        mockGetDoc.mockResolvedValueOnce({
            name: 'SINV-26-00001',
            doctype: 'Sales Invoice',
            company: 'Covai Polymer Traders', // mixed case from ERPNext
            customer: 'FINE PACKAGING',
            grand_total: 129210,
            custom_tally_guid: '3b4a4714-7fa1-4344-a9cf-97e8d4168385-00001234',
            items: [{ item_code: 'HDPE GRANULES', qty: 250, rate: 93, amount: 23250 }],
            taxes: [],
        })

        const res = await app.inject({
            method: 'POST',
            url: '/webhook/erpnext',
            payload: { doctype: 'Sales Invoice', name: 'SINV-26-00001', event: 'on_submit' },
        })

        expect(res.statusCode).toBe(200)
        const body = JSON.parse(res.body)
        expect(body.action).toBe('CREATE')
        // Should use custom_tally_guid from the fetched doc
        expect(body.tallyGuid).toBe('3b4a4714-7fa1-4344-a9cf-97e8d4168385-00001234')
    })

    it('handles Purchase Invoice doctype', async () => {
        mockGetDoc.mockResolvedValueOnce({
            name: 'PINV-26-00001',
            doctype: 'Purchase Invoice',
            company: 'Test Co',
            supplier: 'SERVO PACKAGING LIMITED',
            grand_total: 822500,
            items: [],
            taxes: [],
        })
        const res = await app.inject({
            method: 'POST',
            url: '/webhook/erpnext',
            payload: { doctype: 'Purchase Invoice', name: 'PINV-26-00001', event: 'on_submit' },
        })

        expect(res.statusCode).toBe(200)
        expect(JSON.parse(res.body).action).toBe('CREATE')
        expect(mockEnqueueTallyWrite).toHaveBeenCalledWith(expect.objectContaining({ voucherType: 'Purchase Invoice' }))
    })

    it('handles Payment Entry doctype', async () => {
        mockGetDoc.mockResolvedValueOnce({
            name: 'ACC-PAY-2026-00002',
            doctype: 'Payment Entry',
            company: 'Test Co',
            payment_type: 'Pay',
            party: 'HDFC BANK',
            paid_amount: 33000,
        })
        const res = await app.inject({
            method: 'POST',
            url: '/webhook/erpnext',
            payload: { doctype: 'Payment Entry', name: 'ACC-PAY-2026-00002', event: 'on_submit' },
        })

        expect(res.statusCode).toBe(200)
        expect(mockEnqueueTallyWrite).toHaveBeenCalledWith(expect.objectContaining({ voucherType: 'Payment Entry' }))
    })
})
