/**
 * Step 14 — ERPNext Sales Invoice → Tally Sales Voucher XML input data.
 * Returns a VoucherInput struct (same type the Go writer accepts via JSON job).
 */
import type { ERPNextSalesInvoice, CompanyConfig } from '../../types'
import { erpDateToTally, roundInr } from '../utils'

// Shape matches writer.VoucherInput in Go (serialised as JSON job payload)
export interface TallyVoucherInput {
    action: 'CREATE' | 'ALTER' | 'CANCEL'
    guid: string
    voucherType: string
    objView: string
    date: string // yyyymmdd
    voucherNumber: string
    referenceNumber?: string
    partyLedgerName: string
    narration?: string
    isInvoice: boolean
    placeOfSupply?: string
    isRCMApplicable?: boolean
    ledgerEntries: TallyLedgerEntryInput[]
    inventoryEntries: TallyInventoryEntryInput[]
}

export interface TallyLedgerEntryInput {
    ledgerName: string
    isDeemedPositive: boolean
    isPartyLedger: boolean
    amount: number
    billAllocations: TallyBillAllocationInput[]
    costCentreAllocations?: TallyCostCentreAllocationInput[]
}

export interface TallyCostCentreAllocationInput {
    name: string    // cost centre name (Tally name, without ABBR suffix)
    amount: number  // positive amount
}

export interface TallyBillAllocationInput {
    name: string
    billType: 'New Ref' | 'Agst Ref' | 'Advance'
    amount: number
    dueDate?: string
}

export interface TallyInventoryEntryInput {
    stockItemName: string
    rate: number
    rateUOM: string
    amount: number
    billedQty: number
    billedQtyUOM: string
    hsnCode?: string
    accountLedger?: string
}

export function erpSalesToTally(
    doc: ERPNextSalesInvoice,
    config: CompanyConfig,
    action: 'CREATE' | 'ALTER' | 'CANCEL' = 'CREATE',
): TallyVoucherInput {
    const ledgerEntries: TallyLedgerEntryInput[] = []
    const inventoryEntries: TallyInventoryEntryInput[] = []

    const total = doc.grand_total

    // Party Dr entry
    ledgerEntries.push({
        ledgerName: doc.customer,
        isDeemedPositive: true,
        isPartyLedger: true,
        amount: total,
        billAllocations: [
            {
                name: doc.bill_no || 'INV-REF',
                billType: 'New Ref',
                amount: total,
            },
        ],
    })

    // Sales income Cr entries
    for (const item of doc.items) {
        // Reverse-map ERPNext account → Tally ledger name
        const tallyLedger = reverseMapAccount(item.income_account, config)
        ledgerEntries.push({
            ledgerName: tallyLedger,
            isDeemedPositive: false,
            isPartyLedger: false,
            amount: -item.amount,
            billAllocations: [],
        })
        inventoryEntries.push({
            stockItemName: item.item_code,
            rate: item.rate,
            rateUOM: item.uom,
            amount: -item.amount,
            billedQty: item.qty,
            billedQtyUOM: item.uom,
            hsnCode: item.gst_hsn_code,
            accountLedger: tallyLedger,
        })
    }

    // GST Cr entries
    for (const tax of doc.taxes) {
        const tallyGSTLedger = reverseMapAccount(tax.account_head, config)
        ledgerEntries.push({
            ledgerName: tallyGSTLedger,
            isDeemedPositive: false,
            isPartyLedger: false,
            amount: -roundInr(tax.tax_amount),
            billAllocations: [],
        })
    }

    return {
        action,
        guid: doc.custom_tally_guid ?? `ERP-${doc.name}`,
        voucherType: 'Sales',
        objView: 'Accounting Voucher View',
        date: erpDateToTally(doc.posting_date),
        voucherNumber: doc.bill_no ?? doc.name ?? '',
        partyLedgerName: doc.customer,
        narration: doc.remarks,
        isInvoice: true,
        ledgerEntries,
        inventoryEntries,
    }
}

/** Reverse lookup: ERPNext account → Tally ledger name.
 *  Checks GST ledger mappings first (more specific), then account mappings. */
function reverseMapAccount(erpAccount: string, config: CompanyConfig): string {
    // Check GST ledger mappings first — these are unambiguous
    for (const [, tallyName] of Object.entries(config.gstLedgerMappings)) {
        if (tallyName === erpAccount) {
            // Find the Tally ledger name that maps to this ERPNext account
            for (const [tally, erp] of Object.entries(config.accountMappings)) {
                if (erp === erpAccount) return tally
            }
        }
    }
    // Regular account mappings
    for (const [tally, erp] of Object.entries(config.accountMappings)) {
        if (erp === erpAccount) return tally
    }
    return erpAccount
}
