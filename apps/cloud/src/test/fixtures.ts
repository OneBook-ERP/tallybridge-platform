/**
 * Test fixtures — factory functions for creating test data.
 */
import type { TallyVoucher, TallyLedgerEntry, TallyInventoryEntry, CompanyConfig } from '../types'

// ── Minimal valid CompanyConfig ─────────────────────────────────────────────

export function makeConfig(overrides: Partial<CompanyConfig> = {}): CompanyConfig {
    // Mirrors real Covai Polymer Traders config — account names match ERPNext COA
    return {
        companyId: 'test-company-id',
        erpnextCompany: 'Test Company',
        companyGstin: '33AABCZ2616B1ZV', // Tamil Nadu (state code 33)
        currency: 'INR',
        accountMappings: {
            'B2B SALES': '4110 - Sales - TC',
            'B2B PURCHASE': '1410 - Stock In Hand - TC',
            Cash: '1211 - Cash - TC',
            'HDFC BANK': '1220 - HDFC Bank - TC',
            'Sundry Debtors': '1310 - Debtors - TC',
            'Sundry Creditors': '2110 - Creditors - TC',
            'OFFICE RENT': '5209 - Office Rent - TC',
            PURCHASES: '1410 - Stock In Hand - TC',
            'Default Income': '4110 - Sales - TC',
            'Default Purchase': '1410 - Stock In Hand - TC',
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
        submitMode: { default: 'submit' },
        ...overrides,
    }
}

// ── Tally voucher factories ────────────────────────────────────────────────

export function makeLedgerEntry(overrides: Partial<TallyLedgerEntry> = {}): TallyLedgerEntry {
    return {
        ledgerName: 'B2B SALES',
        isDeemedPositive: false,
        isPartyLedger: false,
        amount: -32750,
        billAllocations: [],
        bankAllocations: [],
        ...overrides,
    }
}

export function makeInventoryEntry(overrides: Partial<TallyInventoryEntry> = {}): TallyInventoryEntry {
    // Mirrors real Tally inventory: HDPE GRANULES at 93/KG, 250 KGS
    return {
        stockItemName: 'HDPE GRANULES',
        rate: 93,
        rateUOM: 'KGS',
        amount: 23250,
        actualQty: 250,
        actualQtyUOM: 'KGS',
        billedQty: 250,
        billedQtyUOM: 'KGS',
        hsnCode: '999111',
        gstOvrdnRate: 0,
        godownName: 'Main Location',
        expiryDate: '',
        accountLedgerName: 'B2B SALES',
        ...overrides,
    }
}

export function makeVoucher(overrides: Partial<TallyVoucher> = {}): TallyVoucher {
    // Dates use RFC3339 format — Go's time.Time marshals to this via json.Marshal
    return {
        guid: '3b4a4714-7fa1-4344-a9cf-97e8d4168385-00002cf6',
        date: '2023-06-20T00:00:00Z',
        alteredOn: '2023-06-20T12:00:00Z',
        voucherTypeName: 'Sales',
        voucherNumber: '175',
        referenceNumber: '',
        referenceDate: '',
        partyLedgerName: 'ANU POLYMERS',
        isInvoice: true,
        isOptional: false,
        isCancelled: false,
        narration: 'Being goods sold',
        foreignCurrency: '',
        foreignAmount: 0,
        placeOfSupply: 'Tamil Nadu',
        partyGSTIN: '33AAUFA2081K1Z9',
        isRCMApplicable: false,
        ewayBillNumber: '',
        irnNo: '',
        ledgerEntries: [
            makeLedgerEntry({ ledgerName: 'ANU POLYMERS', isPartyLedger: true, isDeemedPositive: true, amount: 38645 }),
            makeLedgerEntry({ ledgerName: 'B2B SALES', amount: -32750 }),
            makeLedgerEntry({ ledgerName: 'OUTPUT CGST', amount: -2947.5 }),
            makeLedgerEntry({ ledgerName: 'OUTPUT SGST', amount: -2947.5 }),
        ],
        inventoryEntries: [makeInventoryEntry()],
        ...overrides,
    }
}

/** Sales voucher with inventory items and intra-state GST (TN→TN) */
export function makeSalesVoucher(overrides: Partial<TallyVoucher> = {}): TallyVoucher {
    return makeVoucher(overrides)
}

/** Purchase voucher — mirrors real Tally purchase (SERVO PACKAGING LIMITED) */
export function makePurchaseVoucher(overrides: Partial<TallyVoucher> = {}): TallyVoucher {
    return makeVoucher({
        guid: '3b4a4714-7fa1-4344-a9cf-97e8d4168385-00002b69',
        voucherTypeName: 'Purchase',
        voucherNumber: '26',
        date: '2023-05-09T00:00:00Z',
        partyLedgerName: 'SERVO PACKAGING LIMITED',
        partyGSTIN: '27AAHCS6789E1ZA',
        narration: 'Being goods purchased',
        ledgerEntries: [
            makeLedgerEntry({
                ledgerName: 'SERVO PACKAGING LIMITED',
                isPartyLedger: true,
                isDeemedPositive: false,
                amount: -822500,
            }),
            makeLedgerEntry({ ledgerName: 'PURCHASES', isDeemedPositive: true, amount: 822500 }),
        ],
        inventoryEntries: [
            makeInventoryEntry({
                stockItemName: 'FILLER',
                accountLedgerName: 'PURCHASES',
                rate: 31,
                amount: -310000,
                billedQty: -10000,
                actualQty: -10000,
            }),
        ],
        ...overrides,
    })
}

/** Payment voucher (paying a supplier) — mirrors real Tally payment.
 * Dr: Supplier A/c (isDeemedPositive=true, reduces payable)
 * Cr: HDFC BANK (isDeemedPositive=false, reduces bank balance)
 */
export function makePaymentVoucher(overrides: Partial<TallyVoucher> = {}): TallyVoucher {
    return makeVoucher({
        guid: '3b4a4714-7fa1-4344-a9cf-97e8d4168385-0000338b',
        voucherTypeName: 'Payment',
        voucherNumber: 'PMT-001',
        date: '2023-04-01T00:00:00Z',
        partyLedgerName: 'SERVO PACKAGING LIMITED',
        partyGSTIN: '',
        narration: 'Supplier payment',
        inventoryEntries: [],
        ledgerEntries: [
            makeLedgerEntry({
                ledgerName: 'SERVO PACKAGING LIMITED',
                isPartyLedger: true,
                isDeemedPositive: true,
                amount: 33000,
            }),
            makeLedgerEntry({ ledgerName: 'HDFC BANK', isDeemedPositive: false, amount: -33000 }),
        ],
        ...overrides,
    })
}

/** Receipt voucher (receiving from customer) — mirrors real Tally receipt */
export function makeReceiptVoucher(overrides: Partial<TallyVoucher> = {}): TallyVoucher {
    return makeVoucher({
        voucherTypeName: 'Receipt',
        voucherNumber: 'RCPT-001',
        partyLedgerName: 'ANU POLYMERS',
        partyGSTIN: '',
        narration: 'Being amount received',
        inventoryEntries: [],
        ledgerEntries: [
            makeLedgerEntry({
                ledgerName: 'ANU POLYMERS',
                isPartyLedger: true,
                isDeemedPositive: false,
                amount: -38645,
            }),
            makeLedgerEntry({ ledgerName: 'HDFC BANK', isDeemedPositive: true, amount: 38645 }),
        ],
        ...overrides,
    })
}

/** Journal voucher — mirrors real Tally journal */
export function makeJournalVoucher(overrides: Partial<TallyVoucher> = {}): TallyVoucher {
    return makeVoucher({
        voucherTypeName: 'Journal',
        voucherNumber: 'JV-001',
        partyLedgerName: '',
        partyGSTIN: '',
        narration: 'Being adjustment entry',
        inventoryEntries: [],
        ledgerEntries: [
            makeLedgerEntry({ ledgerName: 'B2B SALES', isDeemedPositive: true, amount: 5000 }),
            makeLedgerEntry({ ledgerName: 'HDFC BANK', isDeemedPositive: false, amount: -5000 }),
        ],
        ...overrides,
    })
}

/**
 * PascalCase voucher — simulates what Go would send IF Voucher struct had no json tags.
 * In reality, Go Voucher struct HAS json tags (sends camelCase), but this fixture tests
 * the normalize path for backward compatibility. Dates are RFC3339 (Go's time.Time format).
 */
export function makePascalCaseVoucher(): Record<string, unknown> {
    return {
        GUID: '3b4a4714-7fa1-4344-a9cf-97e8d4168385-00002cf6',
        Date: '2023-06-20T00:00:00Z',
        AlteredOn: '2023-06-20T15:30:00Z',
        VoucherTypeName: 'Sales',
        VoucherNumber: '175',
        ReferenceNumber: '',
        ReferenceDate: '0001-01-01T00:00:00Z',
        PartyLedgerName: 'ANU POLYMERS',
        IsInvoice: true,
        IsOptional: false,
        IsCancelled: false,
        Narration: 'Being goods sold',
        ForeignCurrency: '',
        ForeignAmount: 0,
        PlaceOfSupply: 'Tamil Nadu',
        PartyGSTIN: '33AAUFA2081K1Z9',
        IsRCMApplicable: false,
        EWayBillNumber: '',
        IRNNO: '',
        LedgerEntries: [
            {
                LedgerName: 'ANU POLYMERS',
                IsDeemedPositive: true,
                IsPartyLedger: true,
                Amount: 38645,
                BillAllocations: [{ Name: '175', BillType: 'New Ref', Amount: 38645, DueDate: '2023-06-20T00:00:00Z' }],
                BankAllocations: [],
            },
            {
                LedgerName: 'B2B SALES',
                IsDeemedPositive: false,
                IsPartyLedger: false,
                Amount: -32750,
                BillAllocations: [],
                BankAllocations: [],
            },
        ],
        InventoryEntries: [
            {
                StockItemName: 'HDPE GRANULES',
                Rate: 93,
                RateUOM: 'KGS',
                Amount: 23250,
                ActualQty: 250,
                ActualQtyUOM: 'KGS',
                BilledQty: 250,
                BilledQtyUOM: 'KGS',
                HSNCode: '999111',
                GSTOvrdnRate: 0,
                GodownName: 'Main Location',
                ExpiryDate: '',
                AccountLedgerName: 'B2B SALES',
            },
        ],
    }
}

// ── ERPNext document factories (for erp-to-tally transform tests) ────────────

import type { ERPNextSalesInvoice, ERPNextPurchaseInvoice, ERPNextPaymentEntry, ERPNextJournalEntry } from '../types'

export function makeERPNextSalesInvoice(overrides: Partial<ERPNextSalesInvoice> = {}): ERPNextSalesInvoice {
    // Mirrors real SINV-26-00023 from ERPNext (Covai Polymer Traders)
    return {
        doctype: 'Sales Invoice',
        name: 'SINV-26-00023',
        customer: 'ANU POLYMERS',
        company: 'Test Company',
        posting_date: '2023-06-20',
        is_return: 0,
        currency: 'INR',
        conversion_rate: 1,
        place_of_supply: '33-Tamil Nadu',
        is_inter_state: 0,
        gst_category: 'Registered Regular',
        customer_gstin: '33AAUFA2081K1Z9',
        company_gstin: '33AABCZ2616B1ZV',
        is_rcm_applicable: 0,
        items: [
            {
                item_code: 'HDPE GRANULES',
                item_name: 'HDPE GRANULES',
                qty: 250,
                uom: 'KGS',
                rate: 93,
                amount: 23250,
                income_account: '4110 - Sales - TC',
                gst_hsn_code: '999111',
            },
        ],
        taxes: [
            { charge_type: 'On Net Total', account_head: 'Output Tax CGST - TC', tax_amount: 2947.5, rate: 9 },
            { charge_type: 'On Net Total', account_head: 'Output Tax SGST - TC', tax_amount: 2947.5, rate: 9 },
        ],
        total: 32750,
        total_taxes_and_charges: 5895,
        grand_total: 38645,
        custom_tally_guid: '3b4a4714-7fa1-4344-a9cf-97e8d4168385-00002cf6',
        ...overrides,
    }
}

export function makeERPNextPurchaseInvoice(overrides: Partial<ERPNextPurchaseInvoice> = {}): ERPNextPurchaseInvoice {
    // Mirrors real PINV-26-00001 from ERPNext (SERVO PACKAGING LIMITED, inter-state)
    return {
        doctype: 'Purchase Invoice',
        name: 'PINV-26-00001',
        supplier: 'SERVO PACKAGING LIMITED',
        company: 'Test Company',
        posting_date: '2023-05-09',
        bill_no: '26',
        bill_date: '2023-05-09',
        is_return: 0,
        currency: 'INR',
        conversion_rate: 1,
        is_inter_state: 0,
        gst_category: 'Registered Regular',
        supplier_gstin: '27AAHCS6789E1ZA',
        is_rcm_applicable: 0,
        items: [
            {
                item_code: 'FILLER',
                item_name: 'FILLER',
                qty: 10000,
                uom: 'KGS',
                rate: 31,
                amount: 310000,
                expense_account: '1410 - Stock In Hand - TC',
                gst_hsn_code: '999111',
            },
        ],
        taxes: [
            { charge_type: 'On Net Total', account_head: 'Input Tax CGST - TC', tax_amount: 27900, rate: 9 },
            { charge_type: 'On Net Total', account_head: 'Input Tax SGST - TC', tax_amount: 27900, rate: 9 },
        ],
        total: 822500,
        total_taxes_and_charges: 0,
        grand_total: 822500,
        custom_tally_guid: '3b4a4714-7fa1-4344-a9cf-97e8d4168385-00002b69',
        ...overrides,
    }
}

export function makeERPNextPaymentEntry(overrides: Partial<ERPNextPaymentEntry> = {}): ERPNextPaymentEntry {
    // Mirrors real ACC-PAY-2026-00002 from ERPNext
    return {
        doctype: 'Payment Entry',
        name: 'ACC-PAY-2026-00002',
        payment_type: 'Pay',
        posting_date: '2023-04-01',
        party_type: 'Supplier',
        party: 'HDFC BANK',
        company: 'Test Company',
        paid_from: '5209 - Office Rent - TC',
        paid_to: '2110 - Creditors - TC',
        paid_from_account_currency: 'INR',
        paid_to_account_currency: 'INR',
        paid_amount: 33000,
        received_amount: 33000,
        source_exchange_rate: 1,
        target_exchange_rate: 1,
        references: [],
        custom_tally_guid: '3b4a4714-7fa1-4344-a9cf-97e8d4168385-000029ac',
        ...overrides,
    }
}

export function makeERPNextJournalEntry(overrides: Partial<ERPNextJournalEntry> = {}): ERPNextJournalEntry {
    // Mirrors real ACC-JV-2026-00001 structure from ERPNext
    return {
        doctype: 'Journal Entry',
        name: 'ACC-JV-2026-00001',
        voucher_type: 'Journal Entry',
        posting_date: '2023-04-01',
        company: 'Test Company',
        user_remark: 'Being expenses adjusted',
        accounts: [
            { account: '4110 - Sales - TC', debit_in_account_currency: 14904, credit_in_account_currency: 0 },
            { account: '1220 - HDFC Bank - TC', debit_in_account_currency: 0, credit_in_account_currency: 14904 },
        ],
        total_debit: 14904,
        total_credit: 14904,
        custom_tally_guid: '3b4a4714-7fa1-4344-a9cf-97e8d4168385-00003647',
        ...overrides,
    }
}

/** Inter-state voucher (TN seller → MH buyer) — IGST instead of CGST+SGST */
export function makeInterStateVoucher(overrides: Partial<TallyVoucher> = {}): TallyVoucher {
    return makeVoucher({
        placeOfSupply: 'Maharashtra',
        partyGSTIN: '27AAHCS6789E1ZA',
        ledgerEntries: [
            makeLedgerEntry({
                ledgerName: 'SERVO PACKAGING LIMITED',
                isPartyLedger: true,
                isDeemedPositive: true,
                amount: 38645,
            }),
            makeLedgerEntry({ ledgerName: 'B2B SALES', amount: -32750 }),
            makeLedgerEntry({ ledgerName: 'OUTPUT IGST', amount: -5895 }),
        ],
        ...overrides,
    })
}
