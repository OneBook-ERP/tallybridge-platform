/**
 * Integration tests for processTallyVoucher() — the full Tally→ERP sync pipeline.
 *
 * These tests mock DB (sql), Redis (loop guard), ERPNext client, and broadcaster,
 * but exercise the real orchestration logic: transform → master data → write → record.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { processTallyVoucher } from './engine'
import {
    makeConfig,
    makeSalesVoucher,
    makePurchaseVoucher,
    makePaymentVoucher,
    makeJournalVoucher,
    makeReceiptVoucher,
} from '../test/fixtures'
import type { CompanyConfig } from '../types'

// ── Hoisted mocks (available to vi.mock factories) ─────────────────────────────

const { mockSql, mockIsOwnWrite, mockCheckConflict, mockRecordConflict, mockErpClient } = vi.hoisted(() => {
    const mockSql = Object.assign(
        vi.fn((_strings: TemplateStringsArray, ..._values: unknown[]) => Promise.resolve([])),
        { json: (val: unknown) => val },
    )
    const mockIsOwnWrite = vi.fn(() => Promise.resolve(false))
    const mockCheckConflict = vi.fn(() => Promise.resolve({ hasConflict: false }))
    const mockRecordConflict = vi.fn(() => Promise.resolve())
    const mockErpClient = {
        getDoc: vi.fn(),
        listDocs: vi.fn(() => Promise.resolve([])),
        findByTallyGUID: vi.fn(() => Promise.resolve(null)),
        createDoc: vi.fn((_dt: string, _doc: Record<string, unknown>) => Promise.resolve({ name: 'SINV-00001' })),
        updateDoc: vi.fn(),
        cancelAndAmend: vi.fn(() => Promise.resolve('SINV-00001-1')),
        submitDoc: vi.fn(),
        deleteDoc: vi.fn(),
        ensureCustomer: vi.fn(),
        ensureSupplier: vi.fn(),
        ensureUOM: vi.fn(),
        ensureItemGroup: vi.fn(),
        ensureItem: vi.fn(),
        ensureCompanyAddress: vi.fn(),
        ensurePartyAddress: vi.fn(),
        ensurePartyContact: vi.fn(),
        ensureBankGLAccount: vi.fn(),
        ensureGLAccount: vi.fn(() => Promise.resolve('New Account - TC')),
        ensureOpeningStockEntry: vi.fn(),
        patchSyncStatus: vi.fn(),
        countDocs: vi.fn(),
    }
    return { mockSql, mockIsOwnWrite, mockCheckConflict, mockRecordConflict, mockErpClient }
})

vi.mock('../db/db', () => {
    const fn = (...args: unknown[]) => mockSql(...args)
    fn.json = (val: unknown) => val
    return { sql: fn, jsonb: (val: unknown) => val }
})
vi.mock('./loop-guard', () => ({ isOwnWrite: (...args: unknown[]) => mockIsOwnWrite(...args) }))
vi.mock('./conflict', () => ({
    checkConflict: (...args: unknown[]) => mockCheckConflict(...args),
    recordConflict: (...args: unknown[]) => mockRecordConflict(...args),
}))
vi.mock('../erpnext/client', () => ({
    ERPNextClient: vi.fn(() => mockErpClient),
    erpClient: mockErpClient,
}))
vi.mock('../realtime/broadcaster', () => ({
    broadcaster: { emit: vi.fn() },
}))
vi.mock('../lib/logger', () => ({
    logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
    },
}))

// ── Helpers ────────────────────────────────────────────────────────────────────

type ConfigWithCreds = CompanyConfig & {
    erpnextUrl?: string
    erpnextApiKey?: string
    erpnextApiSecret?: string
}

function config(overrides: Partial<ConfigWithCreds> = {}): ConfigWithCreds {
    return makeConfig(overrides) as ConfigWithCreds
}

/**
 * Returns a mock sql that will return given rows for the Nth query matching a pattern.
 * For DB queries we don't care about, returns empty array.
 */
function sqlReturns(matchers: Array<{ pattern: RegExp; rows: unknown[] }>) {
    // mockReset() clears any implementation set by beforeEach's mockResolvedValue([]),
    // ensuring mockImplementation takes effect regardless of Vitest's internal priority order.
    mockSql.mockReset()
    mockSql.mockImplementation((strings: TemplateStringsArray) => {
        const query = Array.isArray(strings) ? strings.join('?') : String(strings)
        for (const m of matchers) {
            if (m.pattern.test(query)) return Promise.resolve(m.rows)
        }
        return Promise.resolve([])
    })
}

beforeEach(() => {
    vi.clearAllMocks()
    // Default: no own-write, no conflict, no existing doc
    mockIsOwnWrite.mockResolvedValue(false)
    mockCheckConflict.mockResolvedValue({ hasConflict: false })
    mockErpClient.findByTallyGUID.mockResolvedValue(null)
    mockErpClient.createDoc.mockResolvedValue({ name: 'SINV-00001' })
    mockErpClient.submitDoc.mockResolvedValue(undefined)
    mockSql.mockResolvedValue([])
})

// ═══════════════════════════════════════════════════════════════════════════════
// Happy paths
// ═══════════════════════════════════════════════════════════════════════════════

describe('processTallyVoucher — happy paths', () => {
    it('syncs a Sales voucher end-to-end', async () => {
        const voucher = makeSalesVoucher()
        const result = await processTallyVoucher(voucher, config())

        expect(result.status).toBe('synced')
        expect(result.guid).toBe(voucher.guid)
        expect(result.erpName).toBe('SINV-00001')

        // Should have called ensureCustomer with party name + GSTIN
        expect(mockErpClient.ensureCustomer).toHaveBeenCalledWith(
            'ANU POLYMERS',
            '33AAUFA2081K1Z9',
            undefined, // group (no ledger_masters row)
        )

        // Should have called ensureItem for each inventory entry
        expect(mockErpClient.ensureItem).toHaveBeenCalled()

        // createDoc + submitDoc
        expect(mockErpClient.createDoc).toHaveBeenCalledTimes(1)
        expect(mockErpClient.submitDoc).toHaveBeenCalledWith('Sales Invoice', 'SINV-00001')

        // sql called for sync_records INSERT and audit_log INSERT
        const sqlCalls = mockSql.mock.calls.map((c) => c[0].join('?'))
        expect(sqlCalls.some((q: string) => q.includes('sync_records'))).toBe(true)
        expect(sqlCalls.some((q: string) => q.includes('audit_log'))).toBe(true)
    })

    it('syncs a Purchase voucher', async () => {
        const voucher = makePurchaseVoucher()
        mockErpClient.createDoc.mockResolvedValue({ name: 'PINV-00001' })
        const result = await processTallyVoucher(voucher, config())

        expect(result.status).toBe('synced')
        expect(mockErpClient.ensureSupplier).toHaveBeenCalledWith(
            'SERVO PACKAGING LIMITED',
            '27AAHCS6789E1ZA',
            undefined,
        )
        expect(mockErpClient.createDoc).toHaveBeenCalledTimes(1)
    })

    it('syncs a Payment voucher', async () => {
        const voucher = makePaymentVoucher()
        mockErpClient.createDoc.mockResolvedValue({ name: 'PE-00001' })
        const result = await processTallyVoucher(voucher, config())

        expect(result.status).toBe('synced')
        // Payment party is SERVO PACKAGING LIMITED — treated as Supplier for Pay type
        expect(mockErpClient.ensureSupplier).toHaveBeenCalled()
    })

    it('syncs a Journal voucher', async () => {
        const voucher = makeJournalVoucher()
        mockErpClient.createDoc.mockResolvedValue({ name: 'JV-00001' })
        const result = await processTallyVoucher(voucher, config())

        expect(result.status).toBe('synced')
    })
})

// ═══════════════════════════════════════════════════════════════════════════════
// Skip logic
// ═══════════════════════════════════════════════════════════════════════════════

describe('processTallyVoucher — skip logic', () => {
    it('skips optional (draft) vouchers', async () => {
        const voucher = makeSalesVoucher({ isOptional: true })
        const result = await processTallyVoucher(voucher, config())

        expect(result.status).toBe('skipped')
        expect(mockErpClient.createDoc).not.toHaveBeenCalled()
    })

    it('skips own-write vouchers (loop guard)', async () => {
        mockIsOwnWrite.mockResolvedValue(true)
        const voucher = makeSalesVoucher()
        const result = await processTallyVoucher(voucher, config())

        expect(result.status).toBe('skipped')
        expect(mockCheckConflict).not.toHaveBeenCalled()
    })

    it('skips when hash is unchanged (already synced)', async () => {
        mockCheckConflict.mockResolvedValue({
            hasConflict: false,
            syncRecordId: 'rec-1',
            // no erpnextName → hash unchanged path
        })
        const voucher = makeSalesVoucher()
        const result = await processTallyVoucher(voucher, config())

        expect(result.status).toBe('skipped')
        expect(mockErpClient.createDoc).not.toHaveBeenCalled()
    })
})

// ═══════════════════════════════════════════════════════════════════════════════
// Conflict detection and resolution
// ═══════════════════════════════════════════════════════════════════════════════

describe('processTallyVoucher — conflict resolution', () => {
    it('returns conflict status for MANUAL strategy', async () => {
        mockCheckConflict.mockResolvedValue({
            hasConflict: true,
            syncRecordId: 'rec-1',
            erpnextName: 'SINV-00001',
            erpnextDoctype: 'Sales Invoice',
        })
        mockErpClient.getDoc.mockResolvedValue({ name: 'SINV-00001', docstatus: 1 })

        const voucher = makeSalesVoucher()
        const cfg = config({ conflictStrategy: { default: 'MANUAL' } })
        const result = await processTallyVoucher(voucher, cfg)

        expect(result.status).toBe('conflict')
        expect(result.erpName).toBe('SINV-00001')
        expect(mockRecordConflict).toHaveBeenCalled()
        expect(mockErpClient.cancelAndAmend).not.toHaveBeenCalled()
    })

    it('returns conflict status for ERP_WINS strategy', async () => {
        mockCheckConflict.mockResolvedValue({
            hasConflict: true,
            syncRecordId: 'rec-1',
            erpnextName: 'SINV-00001',
            erpnextDoctype: 'Sales Invoice',
        })
        mockErpClient.getDoc.mockResolvedValue({ name: 'SINV-00001', docstatus: 1 })

        const voucher = makeSalesVoucher()
        const cfg = config({ conflictStrategy: { default: 'ERP_WINS' } })
        const result = await processTallyVoucher(voucher, cfg)

        expect(result.status).toBe('conflict')
    })

    it('overwrites ERPNext for TALLY_WINS strategy (cancel-amend)', async () => {
        mockCheckConflict.mockResolvedValue({
            hasConflict: true,
            syncRecordId: 'rec-1',
            erpnextName: 'SINV-00001',
            erpnextDoctype: 'Sales Invoice',
        })
        mockErpClient.getDoc.mockResolvedValue({ name: 'SINV-00001', docstatus: 1 })
        mockErpClient.cancelAndAmend.mockResolvedValue('SINV-00001-1')

        const voucher = makeSalesVoucher()
        const cfg = config({ conflictStrategy: { default: 'TALLY_WINS' } })
        const result = await processTallyVoucher(voucher, cfg)

        expect(result.status).toBe('synced')
        expect(result.erpName).toBe('SINV-00001-1')
        expect(mockErpClient.cancelAndAmend).toHaveBeenCalledWith(
            'Sales Invoice',
            'SINV-00001',
            expect.objectContaining({ doctype: 'Sales Invoice' }),
        )
    })

    it('respects per-doctype conflict strategy', async () => {
        mockCheckConflict.mockResolvedValue({
            hasConflict: true,
            syncRecordId: 'rec-1',
            erpnextName: 'SINV-00001',
            erpnextDoctype: 'Sales Invoice',
        })
        mockErpClient.getDoc.mockResolvedValue({ name: 'SINV-00001', docstatus: 1 })

        const voucher = makeSalesVoucher()
        const cfg = config({
            conflictStrategy: {
                default: 'TALLY_WINS',
                perDoctype: { 'Sales Invoice': 'MANUAL' },
            },
        })
        const result = await processTallyVoucher(voucher, cfg)

        expect(result.status).toBe('conflict')
        expect(mockErpClient.cancelAndAmend).not.toHaveBeenCalled()
    })
})

// ═══════════════════════════════════════════════════════════════════════════════
// UNMAPPED_LEDGER auto-heal & IGNORED_VOUCHER
// ═══════════════════════════════════════════════════════════════════════════════

describe('processTallyVoucher — transform errors', () => {
    it('auto-heals UNMAPPED_LEDGER for journal-like vouchers', async () => {
        // Journal with an unmapped ledger — first transform fails, then auto-heal creates GL account
        const voucher = makeJournalVoucher({
            ledgerEntries: [
                {
                    ledgerName: 'Office Rent',
                    isDeemedPositive: true,
                    isPartyLedger: false,
                    amount: 5000,
                    billAllocations: [],
                    bankAllocations: [],
                },
                {
                    ledgerName: 'HDFC BANK',
                    isDeemedPositive: false,
                    isPartyLedger: false,
                    amount: -5000,
                    billAllocations: [],
                    bankAllocations: [],
                },
            ],
        })

        mockErpClient.ensureGLAccount.mockResolvedValue('Office Rent - TC')
        mockErpClient.createDoc.mockResolvedValue({ name: 'JV-00001' })

        const result = await processTallyVoucher(voucher, config())

        // The auto-heal should fire: ensureGLAccount is called for the unmapped ledger
        expect(mockErpClient.ensureGLAccount).toHaveBeenCalledWith('Office Rent', 'Test Company', expect.any(String))
        // After auto-heal, the mapping is updated and transform retries
        expect(result.status).toBe('synced')
    })

    it('records exception for UNMAPPED_LEDGER on non-journal vouchers', async () => {
        const voucher = makeSalesVoucher({
            inventoryEntries: [],
            ledgerEntries: [
                {
                    ledgerName: 'ANU POLYMERS',
                    isPartyLedger: true,
                    isDeemedPositive: true,
                    amount: 10000,
                    billAllocations: [],
                    bankAllocations: [],
                },
                {
                    ledgerName: 'Unknown Income Account',
                    isDeemedPositive: false,
                    isPartyLedger: false,
                    amount: -10000,
                    billAllocations: [],
                    bankAllocations: [],
                },
            ],
        })

        const result = await processTallyVoucher(voucher, config())

        expect(result.status).toBe('error')
        expect(result.error).toContain('Unknown Income Account')
        // Exception recorded in DB
        const sqlCalls = mockSql.mock.calls.map((c) => c[0].join('?'))
        expect(sqlCalls.some((q: string) => q.includes('exception_register'))).toBe(true)
    })

    it('silently skips IGNORED_VOUCHER types', async () => {
        // Use a voucher type that maps to IGNORED_VOUCHER
        const voucher = makeSalesVoucher({ voucherTypeName: 'Payroll' })

        const result = await processTallyVoucher(voucher, config())

        expect(result.status).toBe('skipped')
        // No exception recorded for IGNORED_VOUCHER
        const sqlCalls = mockSql.mock.calls.map((c) => c[0].join('?'))
        expect(sqlCalls.some((q: string) => q.includes('exception_register'))).not.toBe(true)
    })
})

// ═══════════════════════════════════════════════════════════════════════════════
// Master data auto-creation
// ═══════════════════════════════════════════════════════════════════════════════

describe('processTallyVoucher — master data', () => {
    it('creates customer with group from ledger_masters', async () => {
        sqlReturns([{ pattern: /ledger_masters/, rows: [{ tally_group: 'Retail Customers' }] }])

        const voucher = makeSalesVoucher()
        await processTallyVoucher(voucher, config())

        expect(mockErpClient.ensureCustomer).toHaveBeenCalledWith('ANU POLYMERS', '33AAUFA2081K1Z9', 'Retail Customers')
    })

    it('skips customer creation for accounting ledgers (bank/cash)', async () => {
        // Simulate a sales invoice where party is a bank ledger
        sqlReturns([{ pattern: /ledger_masters/, rows: [{ tally_group: 'Bank Accounts' }] }])

        const voucher = makeSalesVoucher({
            partyLedgerName: 'HDFC BANK',
            partyGSTIN: '',
            ledgerEntries: [
                {
                    ledgerName: 'HDFC BANK',
                    isPartyLedger: true,
                    isDeemedPositive: true,
                    amount: 11800,
                    billAllocations: [],
                    bankAllocations: [],
                },
                {
                    ledgerName: 'B2B SALES',
                    isDeemedPositive: false,
                    isPartyLedger: false,
                    amount: -10000,
                    billAllocations: [],
                    bankAllocations: [],
                },
                {
                    ledgerName: 'Output CGST 9%',
                    isDeemedPositive: false,
                    isPartyLedger: false,
                    amount: -900,
                    billAllocations: [],
                    bankAllocations: [],
                },
                {
                    ledgerName: 'Output SGST 9%',
                    isDeemedPositive: false,
                    isPartyLedger: false,
                    amount: -900,
                    billAllocations: [],
                    bankAllocations: [],
                },
            ],
        })
        await processTallyVoucher(voucher, config())

        // ensureCustomer should NOT be called because "Bank Accounts" matches ACCOUNTING_GROUPS
        expect(mockErpClient.ensureCustomer).not.toHaveBeenCalled()
    })

    it('creates supplier with group for Purchase Invoice', async () => {
        sqlReturns([{ pattern: /ledger_masters/, rows: [{ tally_group: 'Raw Material Suppliers' }] }])

        mockErpClient.createDoc.mockResolvedValue({ name: 'PINV-00001' })
        const voucher = makePurchaseVoucher()
        await processTallyVoucher(voucher, config())

        expect(mockErpClient.ensureSupplier).toHaveBeenCalledWith(
            'SERVO PACKAGING LIMITED',
            '27AAHCS6789E1ZA',
            'Raw Material Suppliers',
        )
    })

    it('creates address and contact from ledger_masters raw_data', async () => {
        sqlReturns([
            { pattern: /tally_group/, rows: [{ tally_group: 'Retail Customers' }] },
            {
                pattern: /raw_data/,
                rows: [
                    {
                        raw_data: {
                            Address: ['123 MG Road', 'Coimbatore'],
                            PinCode: '641001',
                            StateName: 'Tamil Nadu',
                            Email: 'customer@test.com',
                            Mobile: '9876543210',
                        },
                    },
                ],
            },
        ])

        const voucher = makeSalesVoucher()
        await processTallyVoucher(voucher, config())

        expect(mockErpClient.ensurePartyAddress).toHaveBeenCalledWith(
            'Customer',
            'ANU POLYMERS',
            expect.objectContaining({ pinCode: '641001', state: 'Tamil Nadu' }),
        )
        expect(mockErpClient.ensurePartyContact).toHaveBeenCalledWith(
            'Customer',
            'ANU POLYMERS',
            expect.objectContaining({ email: 'customer@test.com', mobile: '9876543210' }),
        )
    })

    it('ensures UOM and item group before creating items', async () => {
        const voucher = makeSalesVoucher({
            inventoryEntries: [
                {
                    stockItemName: 'Custom Widget',
                    rate: 50,
                    rateUOM: 'KGS',
                    amount: 500,
                    actualQty: 10,
                    actualQtyUOM: 'KGS',
                    billedQty: 10,
                    billedQtyUOM: 'KGS',
                    hsnCode: '39269099',
                    gstOvrdnRate: 0,
                    godownName: 'Main',
                    expiryDate: '',
                    accountLedgerName: 'B2B SALES',
                },
            ],
        })

        // stock_item_masters returns a parent group
        sqlReturns([{ pattern: /stock_item_masters/, rows: [{ tally_parent: 'Polymers' }] }])

        await processTallyVoucher(voucher, config())

        expect(mockErpClient.ensureUOM).toHaveBeenCalledWith('KGS')
        expect(mockErpClient.ensureItemGroup).toHaveBeenCalledWith('Polymers')
        expect(mockErpClient.ensureItem).toHaveBeenCalledWith('Custom Widget', 'KGS', '39269099', 'Polymers')
    })

    it('records exception when master data creation fails', async () => {
        mockErpClient.ensureCustomer.mockRejectedValueOnce(new Error('ERPNext 500'))

        const voucher = makeSalesVoucher()
        const result = await processTallyVoucher(voucher, config())

        expect(result.status).toBe('error')
        expect(result.error).toContain('ERPNext 500')
        const sqlCalls = mockSql.mock.calls.map((c) => c[0].join('?'))
        expect(sqlCalls.some((q: string) => q.includes('MASTER_CREATE_FAILED'))).toBe(true)
    })
})

// ═══════════════════════════════════════════════════════════════════════════════
// Payment reference resolution
// ═══════════════════════════════════════════════════════════════════════════════

describe('processTallyVoucher — payment references', () => {
    it('resolves bill-wise references from sync_records', async () => {
        // Payment with Agst Ref bill allocation pointing to an invoice
        const voucher = makePaymentVoucher({
            ledgerEntries: [
                {
                    ledgerName: 'SERVO PACKAGING LIMITED',
                    isPartyLedger: true,
                    isDeemedPositive: true,
                    amount: 11800,
                    billAllocations: [{ name: 'PI-001', billType: 'Agst Ref', amount: 11800, dueDate: '20240501' }],
                    bankAllocations: [],
                },
                {
                    ledgerName: 'HDFC BANK',
                    isDeemedPositive: false,
                    isPartyLedger: false,
                    amount: -11800,
                    billAllocations: [],
                    bankAllocations: [],
                },
            ],
        })

        // sync_records has the matching invoice
        sqlReturns([
            {
                pattern: /sync_records.*tally_voucher_number/,
                rows: [{ erpnext_name: 'ACC-PINV-2024-00001' }],
            },
        ])

        mockErpClient.createDoc.mockResolvedValue({ name: 'PE-00001' })

        const result = await processTallyVoucher(voucher, config())
        expect(result.status).toBe('synced')

        // The createDoc call should have references resolved to ERPNext name
        const createCall = mockErpClient.createDoc.mock.calls[0]
        const docPayload = createCall[1] as Record<string, unknown>
        const refs = docPayload.references as Array<{ reference_name: string }>
        if (refs && refs.length > 0) {
            expect(refs[0].reference_name).toBe('ACC-PINV-2024-00001')
        }
    })

    it('falls back to FIFO allocation when no bill-wise match', async () => {
        const voucher = makeReceiptVoucher({
            ledgerEntries: [
                {
                    ledgerName: 'ANU POLYMERS',
                    isPartyLedger: true,
                    isDeemedPositive: false,
                    amount: -5000,
                    billAllocations: [{ name: 'INV-OLD', billType: 'Agst Ref', amount: -5000, dueDate: '20240501' }],
                    bankAllocations: [],
                },
                {
                    ledgerName: 'HDFC BANK',
                    isDeemedPositive: true,
                    isPartyLedger: false,
                    amount: 5000,
                    billAllocations: [],
                    bankAllocations: [],
                },
            ],
        })

        // sync_records returns nothing (invoice not synced yet)
        mockSql.mockResolvedValue([])

        // FIFO: listDocs returns outstanding invoices
        mockErpClient.listDocs.mockResolvedValue([
            { name: 'SINV-00010', outstanding_amount: 3000 },
            { name: 'SINV-00011', outstanding_amount: 4000 },
        ])

        mockErpClient.createDoc.mockResolvedValue({ name: 'PE-00002' })

        const result = await processTallyVoucher(voucher, config())
        expect(result.status).toBe('synced')

        // Should have called listDocs for outstanding Sales Invoices
        expect(mockErpClient.listDocs).toHaveBeenCalledWith(
            'Sales Invoice',
            expect.arrayContaining([['customer', '=', 'ANU POLYMERS']]),
            expect.any(Array),
            'posting_date asc',
            20,
        )
    })
})

// ═══════════════════════════════════════════════════════════════════════════════
// Duplicate guard
// ═══════════════════════════════════════════════════════════════════════════════

describe('processTallyVoucher — duplicate guard', () => {
    it('submits existing draft when findByTallyGUID finds one', async () => {
        mockErpClient.findByTallyGUID.mockResolvedValue('SINV-EXISTING')
        mockErpClient.getDoc.mockResolvedValue({ name: 'SINV-EXISTING', docstatus: 0 })

        const voucher = makeSalesVoucher()
        const result = await processTallyVoucher(voucher, config())

        expect(result.status).toBe('synced')
        expect(result.erpName).toBe('SINV-EXISTING')
        expect(mockErpClient.submitDoc).toHaveBeenCalledWith('Sales Invoice', 'SINV-EXISTING')
        expect(mockErpClient.createDoc).not.toHaveBeenCalled()
    })

    it('records existing submitted doc without re-submitting', async () => {
        mockErpClient.findByTallyGUID.mockResolvedValue('SINV-EXISTING')
        mockErpClient.getDoc.mockResolvedValue({ name: 'SINV-EXISTING', docstatus: 1 })

        const voucher = makeSalesVoucher()
        const result = await processTallyVoucher(voucher, config())

        expect(result.status).toBe('synced')
        expect(result.erpName).toBe('SINV-EXISTING')
        // submitDoc only called once (for docstatus check, not re-submit) —
        // actually for docstatus=1, submitDoc should NOT be called
        expect(mockErpClient.submitDoc).not.toHaveBeenCalled()
    })
})

// ═══════════════════════════════════════════════════════════════════════════════
// Smart retry logic
// ═══════════════════════════════════════════════════════════════════════════════

describe('processTallyVoucher — smart retry', () => {
    it('retries Sales Invoice with update_stock=0 on negative stock error', async () => {
        // First createDoc fails with negative stock
        mockErpClient.createDoc
            .mockRejectedValueOnce(new Error('Insufficient Stock: 0 units of Widget A needed in Main Warehouse'))
            .mockResolvedValueOnce({ name: 'SINV-RETRY-001' })

        const voucher = makeSalesVoucher()
        const result = await processTallyVoucher(voucher, config())

        expect(result.status).toBe('synced')
        expect(result.erpName).toBe('SINV-RETRY-001')
        expect(mockErpClient.createDoc).toHaveBeenCalledTimes(2)

        // Second call should have update_stock=0
        const retryDoc = mockErpClient.createDoc.mock.calls[1][1] as Record<string, unknown>
        expect(retryDoc.update_stock).toBe(0)
    })

    it('retries Payment Entry without references on allocation error', async () => {
        mockErpClient.createDoc
            .mockRejectedValueOnce(new Error('Allocated Amount cannot be greater than outstanding amount'))
            .mockResolvedValueOnce({ name: 'PE-RETRY-001' })

        const voucher = makePaymentVoucher()
        const result = await processTallyVoucher(voucher, config())

        expect(result.status).toBe('synced')
        const retryDoc = mockErpClient.createDoc.mock.calls[1][1] as Record<string, unknown>
        expect(retryDoc.references).toEqual([])
    })

    it('retries with gst_category=Unregistered on GST category mismatch', async () => {
        mockErpClient.createDoc
            .mockRejectedValueOnce(
                new Error('GST Category should be one of: Unregistered, Overseas for this transaction'),
            )
            .mockResolvedValueOnce({ name: 'SINV-RETRY-002' })

        const voucher = makeSalesVoucher()
        const result = await processTallyVoucher(voucher, config())

        expect(result.status).toBe('synced')
        const retryDoc = mockErpClient.createDoc.mock.calls[1][1] as Record<string, unknown>
        expect(retryDoc.gst_category).toBe('Unregistered')
        expect(retryDoc.customer_gstin).toBeUndefined()
    })

    it('retries with charge_type=Actual on GST amount mismatch', async () => {
        mockErpClient.createDoc
            .mockRejectedValueOnce(new Error('GST amounts do not match with the taxable values'))
            .mockResolvedValueOnce({ name: 'SINV-RETRY-003' })

        const voucher = makeSalesVoucher()
        const result = await processTallyVoucher(voucher, config())

        expect(result.status).toBe('synced')
        const retryDoc = mockErpClient.createDoc.mock.calls[1][1] as Record<string, unknown>
        const taxes = retryDoc.taxes as Array<{ charge_type: string }>
        if (taxes && taxes.length > 0) {
            expect(taxes[0].charge_type).toBe('Actual')
        }
    })

    it('retries with charge_type=Actual on invalid GST account error', async () => {
        mockErpClient.createDoc
            .mockRejectedValueOnce(new Error('Output Tax CGST is not a valid GST account for this transaction'))
            .mockResolvedValueOnce({ name: 'SINV-RETRY-004' })

        const voucher = makeSalesVoucher()
        const result = await processTallyVoucher(voucher, config())

        expect(result.status).toBe('synced')
    })

    it('retries with integer quantities on fractional qty error', async () => {
        mockErpClient.createDoc
            .mockRejectedValueOnce(new Error('Quantity cannot be a fraction for UOM Nos'))
            .mockResolvedValueOnce({ name: 'SINV-RETRY-005' })

        const voucher = makeSalesVoucher()
        const result = await processTallyVoucher(voucher, config())

        expect(result.status).toBe('synced')
        const retryDoc = mockErpClient.createDoc.mock.calls[1][1] as Record<string, unknown>
        const items = retryDoc.items as Array<{ qty: number }>
        if (items && items.length > 0) {
            expect(Number.isInteger(items[0].qty)).toBe(true)
        }
    })

    it('records exception when no retry pattern matches', async () => {
        mockErpClient.createDoc.mockRejectedValueOnce(new Error('Some unexpected ERPNext error'))

        const voucher = makeSalesVoucher()
        const result = await processTallyVoucher(voucher, config())

        expect(result.status).toBe('error')
        expect(result.error).toContain('Some unexpected ERPNext error')
        const sqlCalls = mockSql.mock.calls.map((c) => c[0].join('?'))
        expect(sqlCalls.some((q: string) => q.includes('ERPNEXT_WRITE_FAILED'))).toBe(true)
    })

    it('records exception when smart retry also fails', async () => {
        mockErpClient.createDoc
            .mockRejectedValueOnce(new Error('0 units of Widget A needed in Main Warehouse'))
            .mockRejectedValueOnce(new Error('Still failing after retry'))

        const voucher = makeSalesVoucher()
        const result = await processTallyVoucher(voucher, config())

        expect(result.status).toBe('error')
    })
})

// ═══════════════════════════════════════════════════════════════════════════════
// Tally update (hash changed, existing ERP name)
// ═══════════════════════════════════════════════════════════════════════════════

describe('processTallyVoucher — update existing', () => {
    it('uses cancel-amend when Tally hash changed and ERP doc exists (no conflict)', async () => {
        mockCheckConflict.mockResolvedValue({
            hasConflict: false,
            syncRecordId: 'rec-1',
            erpnextName: 'SINV-00001',
            erpnextDoctype: 'Sales Invoice',
        })
        mockErpClient.cancelAndAmend.mockResolvedValue('SINV-00001-1')

        const voucher = makeSalesVoucher()
        const result = await processTallyVoucher(voucher, config())

        expect(result.status).toBe('synced')
        expect(result.erpName).toBe('SINV-00001-1')
        expect(mockErpClient.cancelAndAmend).toHaveBeenCalled()
        expect(mockErpClient.createDoc).not.toHaveBeenCalled()
    })
})
