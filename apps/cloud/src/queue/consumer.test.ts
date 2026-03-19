/**
 * Tests for BullMQ consumer: loadConfig, processMasterData, classifyLedger
 *
 * Mirrors real system behavior:
 * - sync-jobs worker processes Tally data batches (vouchers, ledgers, stock items)
 * - loadConfig fetches company config from DB
 * - processMasterData upserts ledgers/stock items and pushes to ERPNext
 * - classifyLedger determines ERPNext entity type from Tally group hierarchy
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockSql, mockProcessTallyVoucher, mockBroadcaster } = vi.hoisted(() => {
    const mockSql = Object.assign(
        vi.fn(() => Promise.resolve([])),
        { json: (v: unknown) => v },
    )
    const mockProcessTallyVoucher = vi.fn(() => Promise.resolve({ status: 'synced' }))
    const mockBroadcaster = { emit: vi.fn() }
    return { mockSql, mockProcessTallyVoucher, mockBroadcaster }
})

// ERPNext client method mocks — accessible from tests for assertions
const mockEnsureCustomer = vi.fn(() => Promise.resolve())
const mockEnsureSupplier = vi.fn(() => Promise.resolve())
const mockEnsureCustomerGroup = vi.fn(() => Promise.resolve())
const mockEnsureSupplierGroup = vi.fn(() => Promise.resolve())
const mockEnsurePartyAddress = vi.fn(() => Promise.resolve(null))
const mockEnsurePartyContact = vi.fn(() => Promise.resolve(null))
const mockEnsureBankGLAccount = vi.fn(() => Promise.resolve('Bank - TC'))
const mockEnsureItem = vi.fn(() => Promise.resolve())
const mockEnsureUOM = vi.fn(() => Promise.resolve())
const mockEnsureItemGroup = vi.fn(() => Promise.resolve())
const mockEnsureCompanyAddress = vi.fn(() => Promise.resolve('Test Co - Billing'))
const mockEnsureOpeningStockEntry = vi.fn(() => Promise.resolve())

// Capture the processor function passed to the Worker constructor
let capturedSyncProcessor: ((job: unknown) => Promise<void>) | null = null
let capturedTallyWriteProcessor: ((job: unknown) => Promise<void>) | null = null

vi.mock('bullmq', () => {
    return {
        Worker: class MockWorker {
            constructor(queueName: string, processor: (job: unknown) => Promise<void>) {
                if (queueName === 'sync-jobs') capturedSyncProcessor = processor
                if (queueName === 'tally-write') capturedTallyWriteProcessor = processor
            }
            on() {
                return this
            }
        },
    }
})

vi.mock('../db/db', () => {
    const fn = (...args: unknown[]) => mockSql(...args)
    fn.json = (v: unknown) => v
    return { sql: fn }
})
vi.mock('../sync/engine', () => ({
    processTallyVoucher: (...args: unknown[]) => mockProcessTallyVoucher(...args),
}))
vi.mock('../realtime/broadcaster', () => ({ broadcaster: mockBroadcaster }))
vi.mock('../erpnext/client', () => ({
    ERPNextClient: class MockERPNextClient {
        constructor() {}
        ensureCustomer = (...a: unknown[]) => mockEnsureCustomer(...a)
        ensureSupplier = (...a: unknown[]) => mockEnsureSupplier(...a)
        ensureCustomerGroup = (...a: unknown[]) => mockEnsureCustomerGroup(...a)
        ensureSupplierGroup = (...a: unknown[]) => mockEnsureSupplierGroup(...a)
        ensurePartyAddress = (...a: unknown[]) => mockEnsurePartyAddress(...a)
        ensurePartyContact = (...a: unknown[]) => mockEnsurePartyContact(...a)
        ensureBankGLAccount = (...a: unknown[]) => mockEnsureBankGLAccount(...a)
        ensureItem = (...a: unknown[]) => mockEnsureItem(...a)
        ensureUOM = (...a: unknown[]) => mockEnsureUOM(...a)
        ensureItemGroup = (...a: unknown[]) => mockEnsureItemGroup(...a)
        ensureCompanyAddress = (...a: unknown[]) => mockEnsureCompanyAddress(...a)
        ensureOpeningStockEntry = (...a: unknown[]) => mockEnsureOpeningStockEntry(...a)
    },
}))
vi.mock('../lib/logger', () => ({
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
vi.mock('./queues', () => ({
    redisOpts: { host: 'localhost', port: 6379 },
}))

import { startSyncWorker, startTallyWriteWorker } from './consumer'

const CID = '00000000-0000-0000-0000-000000000001'

// Mirrors real config_profiles row from PostgreSQL
const configRow = {
    account_mappings: { 'B2B SALES': '4110 - Sales - CPT', 'HDFC BANK': '1220 - HDFC Bank - CPT' },
    gst_ledger_mappings: {
        output_cgst: 'Output Tax CGST - CPT',
        output_sgst: 'Output Tax SGST - CPT',
        output_igst: 'Output Tax IGST - CPT',
        input_cgst: 'Input Tax CGST - CPT',
        input_sgst: 'Input Tax SGST - CPT',
        input_igst: 'Input Tax IGST - CPT',
    },
    voucher_type_mappings: {},
    conflict_strategy: { default: 'TALLY_WINS' },
    sync_direction_rules: {},
}
// Mirrors real companies row — matches Covai Polymer Traders setup
const companyRow = {
    erpnext_company: 'Covai Polymer Traders',
    erpnext_abbr: 'CPT',
    erpnext_gstin: '33AABCZ2616B1ZV',
    erpnext_url: 'https://tally.zenpivot.in',
    erpnext_api_key: 'k',
    erpnext_api_secret: 's',
}

function setupConfig() {
    mockSql.mockReset()
    mockSql.mockImplementation((strings: TemplateStringsArray) => {
        const q = Array.isArray(strings) ? strings.join('?') : String(strings)
        if (q.includes('config_profiles')) return Promise.resolve([configRow])
        if (q.includes('companies')) return Promise.resolve([companyRow])
        if (q.includes('ledger_masters') && q.includes('Bank')) return Promise.resolve([{ tally_name: 'HDFC BANK' }])
        if (q.includes('ledger_masters')) return Promise.resolve([])
        if (q.includes('stock_item_masters')) return Promise.resolve([])
        if (q.includes('sync_records')) return Promise.resolve([])
        return Promise.resolve([])
    })
}

beforeEach(() => {
    vi.clearAllMocks()
    capturedSyncProcessor = null
    capturedTallyWriteProcessor = null
    setupConfig()
})

describe('startSyncWorker', () => {
    it('creates a Worker and captures the processor', () => {
        startSyncWorker()
        expect(capturedSyncProcessor).toBeInstanceOf(Function)
    })
})

describe('sync-jobs processor', () => {
    beforeEach(() => {
        startSyncWorker()
    })

    it('skips batch when loadConfig returns null', async () => {
        mockSql.mockReset()
        mockSql.mockResolvedValue([]) // no config_profiles row
        await capturedSyncProcessor!({ data: { companyId: CID, recordType: 'voucher', records: [{}] } })
        expect(mockProcessTallyVoucher).not.toHaveBeenCalled()
    })

    it('routes ledger to processMasterData', async () => {
        // Go Ledger struct has NO json tags → sends PascalCase field names
        await capturedSyncProcessor!({
            data: {
                companyId: CID,
                recordType: 'ledger',
                records: [
                    {
                        Name: 'HDFC BANK',
                        Group: 'Bank Accounts',
                        Parent: 'Bank Accounts',
                        GUID: 'abc-123',
                        OpeningBalance: 150000,
                        PartyGSTIN: '',
                    },
                ],
            },
        })
        const queries = mockSql.mock.calls.map((c) => c[0].join('?'))
        expect(queries.some((q: string) => q.includes('ledger_masters') && q.includes('INSERT'))).toBe(true)
    })

    it('routes stockItem to processMasterData', async () => {
        // Go StockItem struct has NO json tags → sends PascalCase
        await capturedSyncProcessor!({
            data: {
                companyId: CID,
                recordType: 'stockItem',
                records: [
                    {
                        Name: 'HDPE GRANULES',
                        Parent: 'Primary',
                        BaseUnits: 'KGS',
                        GUID: 'si-001',
                        HSNCode: '999111',
                        OpeningBalance: 500,
                        OpeningValue: -32500,
                    },
                ],
            },
        })
        const queries = mockSql.mock.calls.map((c) => c[0].join('?'))
        expect(queries.some((q: string) => q.includes('stock_item_masters') && q.includes('INSERT'))).toBe(true)
    })

    it('calls processTallyVoucher per voucher', async () => {
        // Go Voucher struct has json tags → sends camelCase
        await capturedSyncProcessor!({
            data: {
                companyId: CID,
                recordType: 'voucher',
                records: [
                    {
                        guid: '3b4a4714-7fa1-4344-a9cf-97e8d4168385-00002cf6',
                        voucherTypeName: 'Sales',
                        date: '2023-06-20T00:00:00Z',
                        voucherNumber: '175',
                        partyLedgerName: 'ANU POLYMERS',
                        isInvoice: true,
                        ledgerEntries: [],
                        inventoryEntries: [],
                    },
                    {
                        guid: '3b4a4714-7fa1-4344-a9cf-97e8d4168385-00002b69',
                        voucherTypeName: 'Purchase',
                        date: '2023-05-09T00:00:00Z',
                        voucherNumber: '26',
                        partyLedgerName: 'SERVO PACKAGING LIMITED',
                        isInvoice: true,
                        ledgerEntries: [],
                        inventoryEntries: [],
                    },
                ],
            },
        })
        expect(mockProcessTallyVoucher).toHaveBeenCalledTimes(2)
    })

    it('broadcasts sync:progress after voucher batch', async () => {
        await capturedSyncProcessor!({
            data: {
                companyId: CID,
                recordType: 'voucher',
                records: [
                    {
                        guid: '3b4a4714-7fa1-4344-a9cf-97e8d4168385-00002cf6',
                        voucherTypeName: 'Sales',
                        date: '2023-06-20T00:00:00Z',
                        voucherNumber: '175',
                        partyLedgerName: 'ANU POLYMERS',
                        isInvoice: true,
                        ledgerEntries: [],
                        inventoryEntries: [],
                    },
                ],
            },
        })
        expect(mockBroadcaster.emit).toHaveBeenCalledWith(
            CID,
            'sync:progress',
            expect.objectContaining({ synced: 1, errored: 0 }),
        )
    })

    it('classifyLedger: Sundry Debtors → Customer, pushes to ERPNext', async () => {
        // Real Tally: customer ledgers like "ANU POLYMERS" sit under "Sundry Debtors"
        await capturedSyncProcessor!({
            data: {
                companyId: CID,
                recordType: 'ledger',
                records: [
                    {
                        Name: 'ANU POLYMERS',
                        Group: 'Sundry Debtors',
                        Parent: 'Sundry Debtors',
                        GSTIN: '33AAUFA2081K1Z9',
                    },
                ],
            },
        })
        expect(mockEnsureCustomerGroup).toHaveBeenCalledWith('Sundry Debtors')
        expect(mockEnsureCustomer).toHaveBeenCalledWith('ANU POLYMERS', '33AAUFA2081K1Z9', 'Sundry Debtors', undefined)
    })

    it('classifyLedger: Sundry Creditors → Supplier', async () => {
        // Real Tally: supplier like "SERVO PACKAGING LIMITED" under "Sundry Creditors"
        await capturedSyncProcessor!({
            data: {
                companyId: CID,
                recordType: 'ledger',
                records: [
                    {
                        Name: 'SERVO PACKAGING LIMITED',
                        Group: 'Sundry Creditors',
                        Parent: 'Sundry Creditors',
                        GSTIN: '27AAHCS6789E1ZA',
                    },
                ],
            },
        })
        expect(mockEnsureSupplierGroup).toHaveBeenCalledWith('Sundry Creditors')
        expect(mockEnsureSupplier).toHaveBeenCalledWith(
            'SERVO PACKAGING LIMITED',
            '27AAHCS6789E1ZA',
            'Sundry Creditors',
            undefined,
        )
    })

    it('classifyLedger: Bank Account → Bank, persists mapping', async () => {
        // Real Tally: "HDFC BANK" under "Bank Accounts" group
        await capturedSyncProcessor!({
            data: {
                companyId: CID,
                recordType: 'ledger',
                records: [
                    {
                        Name: 'HDFC BANK',
                        Group: 'Bank Accounts',
                        Parent: 'Bank Accounts',
                        BankAccountNumber: '50200012345678',
                        IFSCode: 'HDFC0001234',
                    },
                ],
            },
        })
        expect(mockEnsureBankGLAccount).toHaveBeenCalledWith('HDFC BANK', 'Covai Polymer Traders', 'CPT')
        // Should update config_profiles with the bank→GL account mapping
        const queries = mockSql.mock.calls.map((c) => c[0].join('?'))
        expect(queries.some((q: string) => q.includes('config_profiles') && q.includes('account_mappings'))).toBe(true)
    })

    it('stock item upsert + ERPNext push', async () => {
        // Real Tally: "FILLER" with KGS unit and HSN code
        await capturedSyncProcessor!({
            data: {
                companyId: CID,
                recordType: 'stockItem',
                records: [
                    {
                        Name: 'FILLER',
                        Parent: 'Primary',
                        BaseUnits: 'KGS',
                        HSNCode: '999111',
                        OpeningBalance: 1000,
                        OpeningValue: -35000,
                    },
                ],
            },
        })
        const queries = mockSql.mock.calls.map((c) => c[0].join('?'))
        expect(queries.some((q: string) => q.includes('stock_item_masters'))).toBe(true)
        expect(mockEnsureItem).toHaveBeenCalledWith('FILLER', 'KGS', '999111', 'Primary')
    })

    it('classifyLedger: Duties & Taxes → Tax (no ERPNext push)', async () => {
        // Real Tally: "OUTPUT CGST" under "Duties & Taxes" group
        await capturedSyncProcessor!({
            data: {
                companyId: CID,
                recordType: 'ledger',
                records: [{ Name: 'OUTPUT CGST', Group: 'Duties & Taxes', Parent: 'Duties & Taxes' }],
            },
        })
        // Tax ledgers are upserted but NOT pushed to ERPNext as Customer/Supplier/Bank
        expect(mockEnsureCustomer).not.toHaveBeenCalled()
        expect(mockEnsureSupplier).not.toHaveBeenCalled()
        expect(mockEnsureBankGLAccount).not.toHaveBeenCalled()
        // But ledger_masters INSERT should have happened
        const queries = mockSql.mock.calls.map((c) => c[0].join('?'))
        expect(queries.some((q: string) => q.includes('ledger_masters') && q.includes('INSERT'))).toBe(true)
    })

    it('classifyLedger: Direct Expenses → Expense (no ERPNext push)', async () => {
        // Real Tally: "OFFICE RENT" under "Indirect Expenses"
        await capturedSyncProcessor!({
            data: {
                companyId: CID,
                recordType: 'ledger',
                records: [{ Name: 'OFFICE RENT', Group: 'Indirect Expenses', Parent: 'Indirect Expenses' }],
            },
        })
        expect(mockEnsureCustomer).not.toHaveBeenCalled()
        expect(mockEnsureSupplier).not.toHaveBeenCalled()
    })

    it('classifyLedger: Sales Accounts → Income (no ERPNext push)', async () => {
        // Real Tally: "B2B SALES" under "Sales Accounts"
        await capturedSyncProcessor!({
            data: {
                companyId: CID,
                recordType: 'ledger',
                records: [{ Name: 'B2B SALES', Group: 'Sales Accounts', Parent: 'Sales Accounts' }],
            },
        })
        expect(mockEnsureCustomer).not.toHaveBeenCalled()
        expect(mockEnsureSupplier).not.toHaveBeenCalled()
    })

    it('classifyLedger: unknown group → Other', async () => {
        await capturedSyncProcessor!({
            data: {
                companyId: CID,
                recordType: 'ledger',
                records: [{ Name: 'MISC LEDGER', Group: 'Miscellaneous', Parent: 'Miscellaneous' }],
            },
        })
        // "Other" type — no ERPNext master push
        expect(mockEnsureCustomer).not.toHaveBeenCalled()
        expect(mockEnsureSupplier).not.toHaveBeenCalled()
        expect(mockEnsureBankGLAccount).not.toHaveBeenCalled()
    })

    it('sorts vouchers: Purchase → Sales → Payment', async () => {
        // VOUCHER_ORDER uses Tally voucherTypeName values: Purchase (0), Sales (1),
        // Journal/Contra (2), Payment/Receipt (3). Ensures stock exists before sales,
        // and invoices exist before payments.
        const callOrder: string[] = []
        mockProcessTallyVoucher.mockImplementation(async (v: Record<string, unknown>) => {
            callOrder.push(v.voucherTypeName as string)
            return { status: 'synced' }
        })

        await capturedSyncProcessor!({
            data: {
                companyId: CID,
                recordType: 'voucher',
                records: [
                    // Deliberately out of order: Payment, Sales, Purchase
                    {
                        guid: 'g3',
                        voucherTypeName: 'Payment',
                        date: '2023-06-20T00:00:00Z',
                        voucherNumber: '1',
                        partyLedgerName: 'HDFC BANK',
                        isInvoice: false,
                        ledgerEntries: [],
                        inventoryEntries: [],
                    },
                    {
                        guid: 'g1',
                        voucherTypeName: 'Sales',
                        date: '2023-06-20T00:00:00Z',
                        voucherNumber: '175',
                        partyLedgerName: 'ANU POLYMERS',
                        isInvoice: true,
                        ledgerEntries: [],
                        inventoryEntries: [],
                    },
                    {
                        guid: 'g2',
                        voucherTypeName: 'Purchase',
                        date: '2023-05-09T00:00:00Z',
                        voucherNumber: '26',
                        partyLedgerName: 'SERVO PACKAGING LIMITED',
                        isInvoice: true,
                        ledgerEntries: [],
                        inventoryEntries: [],
                    },
                ],
            },
        })

        // Purchase (0) → Sales (1) → Payment (3)
        expect(callOrder).toEqual(['Purchase', 'Sales', 'Payment'])
        expect(mockProcessTallyVoucher).toHaveBeenCalledTimes(3)
    })

    it('stock item triggers opening stock entry after batch', async () => {
        // Setup: stock_item_masters has opening quantities
        const origImpl = mockSql.getMockImplementation()
        mockSql.mockImplementation((strings: TemplateStringsArray) => {
            const q = Array.isArray(strings) ? strings.join('?') : String(strings)
            if (q.includes('stock_item_masters') && q.includes('opening_qty')) {
                return Promise.resolve([
                    { tally_name: 'HDPE GRANULES', opening_qty: 500, opening_value: -32500, uom: 'KGS' },
                    { tally_name: 'FILLER', opening_qty: 1000, opening_value: -35000, uom: 'KGS' },
                ])
            }
            return origImpl!(strings)
        })

        await capturedSyncProcessor!({
            data: {
                companyId: CID,
                recordType: 'stockItem',
                records: [
                    {
                        Name: 'HDPE GRANULES',
                        Parent: 'Primary',
                        BaseUnits: 'KGS',
                        HSNCode: '999111',
                        OpeningBalance: 500,
                        OpeningValue: -32500,
                    },
                ],
            },
        })

        expect(mockEnsureOpeningStockEntry).toHaveBeenCalledWith(
            expect.arrayContaining([
                expect.objectContaining({ itemCode: 'HDPE GRANULES', qty: 500, uom: 'KGS' }),
                expect.objectContaining({ itemCode: 'FILLER', qty: 1000, uom: 'KGS' }),
            ]),
            'Covai Polymer Traders',
            expect.stringContaining('Stores'),
            expect.any(String), // FY start date
            expect.any(String), // cost center
        )
    })

    it('stock item ensureUOM called for non-Nos units', async () => {
        await capturedSyncProcessor!({
            data: {
                companyId: CID,
                recordType: 'stockItem',
                records: [
                    {
                        Name: 'HDPE GRANULES',
                        Parent: 'Primary',
                        BaseUnits: 'KGS',
                        HSNCode: '999111',
                        OpeningBalance: 0,
                        OpeningValue: 0,
                    },
                ],
            },
        })
        expect(mockEnsureUOM).toHaveBeenCalledWith('KGS')
        expect(mockEnsureItemGroup).toHaveBeenCalledWith('Primary')
    })

    it('handles errored vouchers in progress broadcast', async () => {
        mockProcessTallyVoucher
            .mockResolvedValueOnce({ status: 'synced' })
            .mockResolvedValueOnce({ status: 'error', error: 'Something failed' })

        await capturedSyncProcessor!({
            data: {
                companyId: CID,
                recordType: 'voucher',
                records: [
                    {
                        guid: 'g1',
                        voucherTypeName: 'Sales',
                        date: '2023-06-20T00:00:00Z',
                        voucherNumber: '175',
                        partyLedgerName: 'ANU POLYMERS',
                        isInvoice: true,
                        ledgerEntries: [],
                        inventoryEntries: [],
                    },
                    {
                        guid: 'g2',
                        voucherTypeName: 'Sales',
                        date: '2023-06-20T00:00:00Z',
                        voucherNumber: '176',
                        partyLedgerName: 'PROGREEN',
                        isInvoice: true,
                        ledgerEntries: [],
                        inventoryEntries: [],
                    },
                ],
            },
        })

        expect(mockBroadcaster.emit).toHaveBeenCalledWith(
            CID,
            'sync:progress',
            expect.objectContaining({ synced: 1, errored: 1 }),
        )
    })

    it('skips ledgers with empty name', async () => {
        await capturedSyncProcessor!({
            data: {
                companyId: CID,
                recordType: 'ledger',
                records: [{ Name: '', Group: 'Sundry Debtors', Parent: 'Sundry Debtors' }],
            },
        })
        // No INSERT should happen for empty name
        const queries = mockSql.mock.calls.map((c) => c[0].join?.('?') ?? '')
        expect(queries.some((q: string) => q.includes('ledger_masters') && q.includes('INSERT'))).toBe(false)
    })
})

describe('startTallyWriteWorker', () => {
    it('creates a tally-write Worker', () => {
        startTallyWriteWorker()
        expect(capturedTallyWriteProcessor).toBeInstanceOf(Function)
    })
})
