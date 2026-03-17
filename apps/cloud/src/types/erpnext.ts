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
    set_posting_time?: 0 | 1 // allow backdated posting
    bill_no?: string // Tally voucher number
    update_stock?: 0 | 1 // direct stock movement without Delivery Note
    set_warehouse?: string // default warehouse for all items
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
    ignore_pricing_rule?: 0 | 1
    payment_terms_template?: string
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
    // e-Invoice / e-Way Bill fields
    custom_ewaybill_no?: string
    custom_irn?: string
    custom_irn_ack_no?: string
    // Address fields
    customer_address?: string
    shipping_address_name?: string
    contact_email?: string
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
    warehouse?: string
    cost_center?: string
    gst_hsn_code?: string
    is_nil_exempt?: 0 | 1
    is_exempt?: 0 | 1
    allow_zero_valuation_rate?: 0 | 1
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
    due_date?: string
    bill_date?: string // supplier's invoice date
    bill_no?: string // supplier's invoice number
    set_posting_time?: 0 | 1
    update_stock?: 0 | 1 // direct stock movement without Purchase Receipt
    set_warehouse?: string
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
    payment_terms_template?: string
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
    // e-Invoice / e-Way Bill fields
    custom_ewaybill_no?: string
    custom_irn?: string
    custom_irn_ack_no?: string
    // Address fields
    supplier_address?: string
    contact_email?: string
}

export interface PurchaseInvoiceItem {
    item_code: string
    item_name: string
    description?: string
    qty: number
    uom: string
    rate: number
    amount: number
    expense_account?: string
    warehouse?: string
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
    advance_payment_entries?: AdvancePaymentEntry[]
    cost_center?: string
    company_gstin?: string
    custom_tally_guid?: string
    custom_tally_voucher_number?: string
    custom_sync_source?: 'TALLYBRIDGE'
}

export interface AdvancePaymentEntry {
    reference_type: 'Sales Invoice' | 'Purchase Invoice'
    reference_name: string
    advance_amount: number
    allocated_amount: number
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
    custom_tally_voucher_number?: string
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
    is_advance?: 'Yes' | 'No'
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

// ── Stock Entry ───────────────────────────────────────────────────────────────

export interface ERPNextStockEntry {
    doctype: 'Stock Entry'
    name?: string
    stock_entry_type: 'Material Issue' | 'Material Receipt' | 'Material Transfer' | 'Material Transfer Entry'
    posting_date: string
    company: string
    from_warehouse?: string
    to_warehouse?: string
    remarks?: string
    items: StockEntryItem[]
    total_amount?: number
    custom_tally_guid?: string
    custom_tally_voucher_number?: string
    custom_sync_source?: 'TALLYBRIDGE'
}

export interface StockEntryItem {
    item_code: string
    item_name?: string
    qty: number
    uom: string
    s_warehouse?: string // source warehouse (for issue/transfer)
    t_warehouse?: string // target warehouse (for receipt/transfer)
    basic_rate?: number
    amount?: number
    cost_center?: string
    gst_hsn_code?: string
}

export type ERPNextDocument =
    | ERPNextSalesInvoice
    | ERPNextPurchaseInvoice
    | ERPNextPaymentEntry
    | ERPNextJournalEntry
    | ERPNextStockEntry
