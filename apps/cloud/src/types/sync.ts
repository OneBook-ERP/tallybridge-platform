/**
 * Step 12 — Sync engine types: company config profile, sync records, results.
 */

// ── Company configuration (from config_profiles JSONB) ───────────────────────

export interface AccountMapping {
    [tallyLedgerName: string]: string // → ERPNext account name
}

export interface GSTLedgerMapping {
    output_cgst: string
    output_sgst: string
    output_igst: string
    input_cgst: string
    input_sgst: string
    input_igst: string
}

export interface VoucherTypeMapping {
    [tallyVoucherType: string]: {
        erpnextDoctype: 'Sales Invoice' | 'Purchase Invoice' | 'Payment Entry' | 'Journal Entry' | 'Stock Entry'
        isReturn?: boolean
        paymentType?: 'Pay' | 'Receive' | 'Internal Transfer'
        journalType?: string
    }
}

export interface ConflictStrategy {
    default: 'TALLY_WINS' | 'ERP_WINS' | 'LAST_WRITE_WINS' | 'MANUAL'
    perDoctype?: {
        [doctype: string]: 'TALLY_WINS' | 'ERP_WINS' | 'LAST_WRITE_WINS' | 'MANUAL'
    }
}

export interface CompanyConfig {
    companyId: string
    erpnextCompany: string // ERPNext company name (for items)
    erpnextAbbr?: string // ERPNext company abbreviation (e.g. "ZP") — used for account suffixes
    companyGstin?: string // Company GSTIN — used to derive state for inter-state GST
    companyAddress?: string // ERPNext Address name (e.g. "Covai Polymer Traders-Billing") — resolved dynamically
    defaultState?: string // Fallback state when GSTIN is not set (e.g. "Tamil Nadu")
    currency: string // "INR"
    defaultWarehouse?: string // e.g. "Stores - CPT" — enables update_stock on Sales/Purchase Invoices
    updateStock?: boolean // if true (default), set update_stock=1 on inventory invoices
    costCenter?: string // e.g. "Main - AC"
    bankLedgers?: string[] // Tally ledger names classified as Bank/Cash — prevents party fallback in resolver
    /** ledgerName → Tally group name (e.g. "HDFC BANK" → "Bank Accounts") loaded from ledger_masters */
    ledgerGroups?: Record<string, string>
    /** Tally group name → ERPNext account name (e.g. "Sales Accounts" → "Sales - CPT") from default-mappings */
    groupDefaultMappings?: Record<string, string>
    accountMappings: AccountMapping
    gstLedgerMappings: GSTLedgerMapping
    voucherTypeMappings: VoucherTypeMapping
    conflictStrategy: ConflictStrategy
    syncDirection: {
        [doctype: string]: 'TALLY_TO_ERP' | 'ERP_TO_TALLY' | 'BOTH'
    }
}

// ── Transform result (all transforms return this) ─────────────────────────────

export type TransformResult<T> =
    | { success: true; doc: T; warnings: string[] }
    | { success: false; error: TransformError }

export interface TransformError {
    code: TransformErrorCode
    message: string
    field?: string
    details?: unknown
}

export type TransformErrorCode =
    | 'UNMAPPED_LEDGER' // Tier 3 — blocks sync
    | 'UNMAPPED_ITEM' // Tier 3
    | 'MISSING_GSTIN' // Tier 3 for B2B
    | 'PLACE_OF_SUPPLY_MISSING' // Tier 3
    | 'MISSING_HSN' // Tier 2 — warning
    | 'ROUND_OFF_AUTO' // Tier 1 — auto-corrected
    | 'MISSING_PAN' // Tier 2
    | 'CURRENCY_NOT_FOUND' // Tier 3
    | 'TRANSFORM_FAILED' // Unexpected — engineering review
    | 'FALLBACK_TO_JOURNAL' // Payment routed to Journal Entry (bank-to-bank)
    | 'IGNORED_VOUCHER' // Voucher type intentionally not synced (HR, payroll, non-accounting)

// ── Sync record (from sync_records table) ─────────────────────────────────────

export interface SyncRecord {
    id: string
    companyId: string
    tallyGuid: string
    erpnextDoctype: string
    erpnextName: string
    tallyHash: string
    erpnextHash: string
    lastSyncedAt: Date
    direction: 'TALLY_TO_ERP' | 'ERP_TO_TALLY' | 'BOTH'
    syncStatus: 'SYNCED' | 'PENDING' | 'ERROR' | 'CONFLICT'
}

// ── Conflict ──────────────────────────────────────────────────────────────────

export interface ConflictRecord {
    id: string
    companyId: string
    tallyGuid: string
    tallySnapshot: Record<string, unknown>
    erpnextSnapshot: Record<string, unknown>
    detectedAt: Date
}
