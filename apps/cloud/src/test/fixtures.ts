/**
 * Test fixtures — factory functions for creating test data.
 */
import type { TallyVoucher, TallyLedgerEntry, TallyInventoryEntry, CompanyConfig } from '../types'

// ── Minimal valid CompanyConfig ─────────────────────────────────────────────

export function makeConfig(overrides: Partial<CompanyConfig> = {}): CompanyConfig {
    return {
        companyId: 'test-company-id',
        erpnextCompany: 'Test Company',
        companyGstin: '33AABCT1234A1ZA',  // Tamil Nadu
        currency: 'INR',
        accountMappings: {
            'B2B Sales': 'Sales - TC',
            'B2B Purchase': 'Cost of Goods Sold - TC',
            'Cash': 'Cash - TC',
            'Bank Account': 'Bank Account - TC',
            'Sundry Debtors': 'Debtors - TC',
            'Sundry Creditors': 'Creditors - TC',
            'Default Income': 'Sales - TC',
            'Default Purchase': 'Cost of Goods Sold - TC',
        },
        gstLedgerMappings: {
            output_cgst: 'Output Tax CGST - TC',
            output_sgst: 'Output Tax SGST - TC',
            output_igst: 'Output Tax IGST - TC',
            input_cgst: 'Input Tax CGST - TC',
            input_sgst: 'Input Tax SGST - TC',
            input_igst: 'Input Tax IGST - TC',
        },
        voucherTypeMappings: {},
        conflictStrategy: { default: 'TALLY_WINS' },
        syncDirection: {},
        ...overrides,
    }
}

// ── Tally voucher factories ────────────────────────────────────────────────

export function makeLedgerEntry(overrides: Partial<TallyLedgerEntry> = {}): TallyLedgerEntry {
    return {
        ledgerName: 'B2B Sales',
        isDeemedPositive: false,
        isPartyLedger: false,
        amount: -10000,
        billAllocations: [],
        bankAllocations: [],
        ...overrides,
    }
}

export function makeInventoryEntry(overrides: Partial<TallyInventoryEntry> = {}): TallyInventoryEntry {
    return {
        stockItemName: 'Widget A',
        rate: 100,
        rateUOM: 'Nos',
        amount: 1000,
        actualQty: 10,
        actualQtyUOM: 'Nos',
        billedQty: 10,
        billedQtyUOM: 'Nos',
        hsnCode: '84719000',
        gstOvrdnRate: 0,
        godownName: 'Main Location',
        expiryDate: '',
        accountLedgerName: 'B2B Sales',
        ...overrides,
    }
}

export function makeVoucher(overrides: Partial<TallyVoucher> = {}): TallyVoucher {
    return {
        guid: 'test-guid-001',
        date: '20240401',
        alteredOn: '20240401120000',
        voucherTypeName: 'Sales',
        voucherNumber: 'SI-001',
        referenceNumber: '',
        referenceDate: '',
        partyLedgerName: 'Customer ABC',
        isInvoice: true,
        isOptional: false,
        isCancelled: false,
        narration: 'Test sale',
        foreignCurrency: '',
        foreignAmount: 0,
        placeOfSupply: 'Tamil Nadu',
        partyGSTIN: '33AABCC1234D1ZA',
        isRCMApplicable: false,
        ewayBillNumber: '',
        irnNo: '',
        ledgerEntries: [
            makeLedgerEntry({ ledgerName: 'Customer ABC', isPartyLedger: true, isDeemedPositive: true, amount: 11800 }),
            makeLedgerEntry({ ledgerName: 'B2B Sales', amount: -10000 }),
            makeLedgerEntry({ ledgerName: 'Output CGST 9%', amount: -900 }),
            makeLedgerEntry({ ledgerName: 'Output SGST 9%', amount: -900 }),
        ],
        inventoryEntries: [
            makeInventoryEntry(),
        ],
        ...overrides,
    }
}

/** Sales voucher with inventory items and intra-state GST (TN→TN) */
export function makeSalesVoucher(overrides: Partial<TallyVoucher> = {}): TallyVoucher {
    return makeVoucher(overrides)
}

/** Purchase voucher */
export function makePurchaseVoucher(overrides: Partial<TallyVoucher> = {}): TallyVoucher {
    return makeVoucher({
        voucherTypeName: 'Purchase',
        voucherNumber: 'PI-001',
        partyLedgerName: 'Supplier XYZ',
        partyGSTIN: '33AABCS5678E1ZB',
        narration: 'Test purchase',
        ledgerEntries: [
            makeLedgerEntry({ ledgerName: 'Supplier XYZ', isPartyLedger: true, isDeemedPositive: false, amount: -11800 }),
            makeLedgerEntry({ ledgerName: 'B2B Purchase', isDeemedPositive: true, amount: 10000 }),
            makeLedgerEntry({ ledgerName: 'Input CGST 9%', isDeemedPositive: true, amount: 900 }),
            makeLedgerEntry({ ledgerName: 'Input SGST 9%', isDeemedPositive: true, amount: 900 }),
        ],
        inventoryEntries: [
            makeInventoryEntry({ accountLedgerName: 'B2B Purchase' }),
        ],
        ...overrides,
    })
}

/** Payment voucher (paying a supplier) */
export function makePaymentVoucher(overrides: Partial<TallyVoucher> = {}): TallyVoucher {
    return makeVoucher({
        voucherTypeName: 'Payment',
        voucherNumber: 'PMT-001',
        partyLedgerName: 'Supplier XYZ',
        partyGSTIN: '',
        narration: 'Payment to supplier',
        inventoryEntries: [],
        ledgerEntries: [
            makeLedgerEntry({ ledgerName: 'Supplier XYZ', isPartyLedger: true, isDeemedPositive: true, amount: 11800 }),
            makeLedgerEntry({ ledgerName: 'Bank Account', isDeemedPositive: false, amount: -11800 }),
        ],
        ...overrides,
    })
}

/** Receipt voucher (receiving from customer) */
export function makeReceiptVoucher(overrides: Partial<TallyVoucher> = {}): TallyVoucher {
    return makeVoucher({
        voucherTypeName: 'Receipt',
        voucherNumber: 'RCPT-001',
        partyLedgerName: 'Customer ABC',
        partyGSTIN: '',
        narration: 'Receipt from customer',
        inventoryEntries: [],
        ledgerEntries: [
            makeLedgerEntry({ ledgerName: 'Customer ABC', isPartyLedger: true, isDeemedPositive: false, amount: -11800 }),
            makeLedgerEntry({ ledgerName: 'Bank Account', isDeemedPositive: true, amount: 11800 }),
        ],
        ...overrides,
    })
}

/** Journal voucher */
export function makeJournalVoucher(overrides: Partial<TallyVoucher> = {}): TallyVoucher {
    return makeVoucher({
        voucherTypeName: 'Journal',
        voucherNumber: 'JV-001',
        partyLedgerName: '',
        partyGSTIN: '',
        narration: 'Adjustment entry',
        inventoryEntries: [],
        ledgerEntries: [
            makeLedgerEntry({ ledgerName: 'B2B Sales', isDeemedPositive: true, amount: 5000 }),
            makeLedgerEntry({ ledgerName: 'Bank Account', isDeemedPositive: false, amount: -5000 }),
        ],
        ...overrides,
    })
}

/** PascalCase voucher as Go would send it (for normalizeVoucher tests) */
export function makePascalCaseVoucher(): Record<string, unknown> {
    return {
        GUID: 'go-guid-001',
        Date: '2024-04-01T00:00:00Z',
        AlteredOn: '2024-04-01T12:00:00Z',
        VoucherTypeName: 'Sales',
        VoucherNumber: 'SI-GO-001',
        ReferenceNumber: '',
        ReferenceDate: '',
        PartyLedgerName: 'Go Customer',
        IsInvoice: true,
        IsOptional: false,
        IsCancelled: false,
        Narration: 'From Go',
        ForeignCurrency: '',
        ForeignAmount: 0,
        PlaceOfSupply: 'Tamil Nadu',
        PartyGSTIN: '33AABCC9999D1ZA',
        IsRCMApplicable: false,
        EWayBillNumber: '',
        IRNNO: '',
        LedgerEntries: [
            {
                LedgerName: 'Go Customer',
                IsDeemedPositive: true,
                IsPartyLedger: true,
                Amount: 11800,
                BillAllocations: [
                    { Name: 'SI-GO-001', BillType: 'New Ref', Amount: 11800, DueDate: '20240501' },
                ],
                BankAllocations: [],
            },
            {
                LedgerName: 'B2B Sales',
                IsDeemedPositive: false,
                IsPartyLedger: false,
                Amount: -10000,
                BillAllocations: [],
                BankAllocations: [],
            },
        ],
        InventoryEntries: [
            {
                StockItemName: 'Go Widget',
                Rate: 100,
                RateUOM: 'Nos',
                Amount: 1000,
                ActualQty: 10,
                ActualQtyUOM: 'Nos',
                BilledQty: 10,
                BilledQtyUOM: 'Nos',
                HSNCode: '84719000',
                GSTOvrdnRate: 0,
                GodownName: 'Main',
                ExpiryDate: '',
                AccountLedgerName: 'B2B Sales',
            },
        ],
    }
}

/** Inter-state voucher (TN seller → MH buyer) */
export function makeInterStateVoucher(overrides: Partial<TallyVoucher> = {}): TallyVoucher {
    return makeVoucher({
        placeOfSupply: 'Maharashtra',
        partyGSTIN: '27AABCC1234D1ZA',
        ledgerEntries: [
            makeLedgerEntry({ ledgerName: 'Customer ABC', isPartyLedger: true, isDeemedPositive: true, amount: 11800 }),
            makeLedgerEntry({ ledgerName: 'B2B Sales', amount: -10000 }),
            makeLedgerEntry({ ledgerName: 'Output IGST 18%', amount: -1800 }),
        ],
        ...overrides,
    })
}
