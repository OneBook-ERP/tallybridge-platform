/**
 * Step 12 — ERPNext document types.
 * Field names match ERPNext REST API JSON exactly.
 * All amounts in INR unless currency field states otherwise.
 */

// ── Sales Invoice ─────────────────────────────────────────────────────────────

export interface ERPNextSalesInvoice {
    doctype: 'Sales Invoice'
    name?: string // auto-assigned by ERP on create
    customer: string
    company: string
    posting_date: string // "YYYY-MM-DD"
    due_date?: string
    bill_no?: string // Tally voucher number
    is_return: 0 | 1
    return_against?: string // name of original SI for credit notes
    currency: string // "INR" default
    conversion_rate: number // 1 for INR
    place_of_supply: string // "27-Maharashtra"
    is_inter_state: 0 | 1
    gst_category: GSTCategory
    customer_gstin?: string
    company_gstin?: string
    company_address?: string
    is_rcm_applicable: 0 | 1
    remarks?: string
    items: SalesInvoiceItem[]
    taxes: TaxLine[]
    total: number
    total_taxes_and_charges: number
    grand_total: number
    outstanding_amount?: number
    // TallyBridge custom fields (require tallybridge_frappe app)
    custom_tally_guid?: string
    custom_tally_voucher_number?: string
    custom_tally_sync_status?: 'Synced' | 'Pending' | 'Error'
    custom_sync_source?: 'TALLYBRIDGE' // loop-guard marker
}

export interface SalesInvoiceItem {
    item_code: string
    item_name: string
    description?: string
    qty: number
    uom: string
    rate: number
    amount: number
    income_account: string
    cost_center?: string
    gst_hsn_code?: string
    is_nil_exempt?: 0 | 1
    is_exempt?: 0 | 1
}

export type GSTCategory =
    | 'Registered Regular'
    | 'Registered Composition'
    | 'Unregistered'
    | 'SEZ'
    | 'Overseas'
    | 'Consumer'
    | 'Deemed Export'

// ── Purchase Invoice ──────────────────────────────────────────────────────────

export interface ERPNextPurchaseInvoice {
    doctype: 'Purchase Invoice'
    name?: string
    supplier: string
    company: string
    posting_date: string
    bill_date?: string // supplier's invoice date
    bill_no?: string // supplier's invoice number
    is_return: 0 | 1
    return_against?: string
    currency: string
    conversion_rate: number
    place_of_supply?: string
    is_inter_state: 0 | 1
    gst_category: GSTCategory
    supplier_gstin?: string
    company_gstin?: string
    company_address?: string
    is_rcm_applicable: 0 | 1
    remarks?: string
    items: PurchaseInvoiceItem[]
    taxes: TaxLine[]
    total: number
    total_taxes_and_charges: number
    grand_total: number
    custom_tally_guid?: string
    custom_tally_voucher_number?: string
    custom_tally_sync_status?: 'Synced' | 'Pending' | 'Error'
    custom_sync_source?: 'TALLYBRIDGE'
}

export interface PurchaseInvoiceItem {
    item_code: string
    item_name: string
    description?: string
    qty: number
    uom: string
    rate: number
    amount: number
    expense_account: string
    cost_center?: string
    gst_hsn_code?: string
}

// ── Payment Entry ─────────────────────────────────────────────────────────────

export interface ERPNextPaymentEntry {
    doctype: 'Payment Entry'
    name?: string
    payment_type: 'Pay' | 'Receive' | 'Internal Transfer'
    posting_date: string
    party_type: 'Customer' | 'Supplier'
    party: string
    party_name?: string
    company: string
    mode_of_payment?: string
    paid_from: string // bank/cash account debited
    paid_to: string // bank/cash account credited
    paid_from_account_currency: string
    paid_to_account_currency: string
    paid_amount: number
    received_amount: number
    source_exchange_rate: number
    target_exchange_rate: number
    reference_no?: string // cheque / UTR number
    reference_date?: string
    remarks?: string
    references: PaymentReference[]
    cost_center?: string
    company_gstin?: string
    custom_tally_guid?: string
    custom_sync_source?: 'TALLYBRIDGE'
}

export interface PaymentReference {
    reference_doctype: 'Sales Invoice' | 'Purchase Invoice' | 'Journal Entry'
    reference_name: string
    total_amount?: number
    outstanding_amount?: number
    allocated_amount: number
}

// ── Journal Entry ─────────────────────────────────────────────────────────────

export interface ERPNextJournalEntry {
    doctype: 'Journal Entry'
    name?: string
    voucher_type: 'Journal Entry' | 'Bank Entry' | 'Cash Entry' | 'Contra Entry' | 'Opening Entry'
    posting_date: string
    company: string
    user_remark?: string
    is_opening?: 'Yes' | 'No'
    accounts: JournalAccount[]
    total_debit: number
    total_credit: number
    company_gstin?: string
    custom_tally_guid?: string
    custom_sync_source?: 'TALLYBRIDGE'
}

export interface JournalAccount {
    account: string
    debit_in_account_currency: number
    credit_in_account_currency: number
    party_type?: 'Customer' | 'Supplier' | ''
    party?: string
    reference_type?: string
    reference_name?: string
    user_remark?: string
    cost_center?: string
}

// ── Shared ────────────────────────────────────────────────────────────────────

export interface TaxLine {
    charge_type: 'Actual' | 'On Net Total' | 'On Previous Row Amount'
    account_head: string
    tax_amount: number
    description?: string
    rate?: number // 0 when charge_type = 'Actual'
    included_in_print_rate?: 0 | 1
}

export type ERPNextDocument = ERPNextSalesInvoice | ERPNextPurchaseInvoice | ERPNextPaymentEntry | ERPNextJournalEntry
