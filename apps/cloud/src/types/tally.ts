/**
 * Step 12 — Tally-side types.
 * Mirrors the Go reader structs (reader/vouchers.go, reader/ledgers.go etc.)
 * as they arrive over the wire from the connector as JSON.
 */

// ── Voucher (API 10/11) ───────────────────────────────────────────────────────

export interface TallyVoucher {
    guid: string
    date: string // "20240401"
    alteredOn: string // "20240401120000" (yyyymmddHHmmss)
    voucherTypeName: string // "Sales" | "Purchase" | "Payment" | "Receipt" | "Journal" | "Contra"
    voucherNumber: string
    referenceNumber: string // supplier's invoice number (for Purchase)
    referenceDate: string // "20240401" (supplier's date)
    partyLedgerName: string
    isInvoice: boolean
    isOptional: boolean // PRD rule: NEVER sync if true — excluded already by connector
    isCancelled: boolean
    narration: string
    foreignCurrency: string
    foreignAmount: number
    placeOfSupply: string // state name e.g. "Maharashtra"
    partyGSTIN: string
    isRCMApplicable: boolean
    ewayBillNumber: string
    irnNo: string
    irn?: string // e-Invoice IRN (alternate field name from some Tally builds)
    irnAckNo?: string // e-Invoice acknowledgment number
    address?: string[] // party address lines from ledger data
    partyEmail?: string // party email from ledger data
    ledgerEntries: TallyLedgerEntry[]
    inventoryEntries: TallyInventoryEntry[]
    // Stock Journal fields
    stockJournalEntries?: TallyStockJournalEntry[]
}

export interface TallyStockJournalEntry {
    stockItemName: string
    godownName?: string // source godown (for transfers/issues)
    destinationGodownName?: string // destination godown (for transfers/receipts)
    rate: number
    amount: number
    actualQty: number
    actualQtyUOM: string
    billedQty: number
    billedQtyUOM: string
    hsnCode?: string
    isDeemedPositive: boolean // true = receipt into godown, false = issue from godown
}

export interface TallyLedgerEntry {
    ledgerName: string
    isDeemedPositive: boolean // true=Debit, false=Credit
    isPartyLedger: boolean
    amount: number // signed: positive=Debit in Tally's sense
    billAllocations: TallyBillAllocation[]
    bankAllocations: TallyBankAllocation[]
}

export interface TallyBillAllocation {
    name: string // invoice reference
    billType: 'New Ref' | 'Agst Ref' | 'Advance'
    amount: number
    dueDate: string // "20240501"
}

export interface TallyBankAllocation {
    instNumber: string // cheque / DD number
    uniqueReferenceNumber: string // UTR for NEFT/RTGS
    transactionType: string // Cheque | NEFT | RTGS | UPI
}

export interface TallyInventoryEntry {
    stockItemName: string
    rate: number
    rateUOM: string
    amount: number
    actualQty: number
    actualQtyUOM: string
    billedQty: number
    billedQtyUOM: string
    hsnCode: string
    gstOvrdnRate: number
    godownName: string
    expiryDate: string
    accountLedgerName: string // income / purchase account from ACCOUNTINGALLOCATIONS
}

// ── Ledger master (API 3) ─────────────────────────────────────────────────────

export interface TallyLedger {
    name: string
    parent: string
    guid: string
    mailingName: string
    address: string[]
    pinCode: string
    countryName: string
    stateName: string
    email: string
    mobile: string
    panItNo: string
    gstRegistrationType: string
    partyGSTIN: string
    isBillWiseOn: boolean
    creditPeriod: string
    openingBalance: number
    alteredOn: string
}

// ── Stock item master (API 5) ─────────────────────────────────────────────────

export interface TallyStockItem {
    name: string
    parent: string
    baseUnits: string
    guid: string
    hsnCode: string
    gstApplicable: string
    taxClassificationName: string
    gstRate: number
    openingBalance: number
    openingRate: number
    alteredOn: string
}

// ── Sync batch (what connector ships to POST /connector/sync-data) ────────────

export interface TallySyncBatch {
    companyId: string
    batchId: string
    fromTimestamp: string // yyyymmddHHmmss
    toTimestamp: string
    vouchers?: TallyVoucher[]
    ledgers?: TallyLedger[]
    stockItems?: TallyStockItem[]
}
