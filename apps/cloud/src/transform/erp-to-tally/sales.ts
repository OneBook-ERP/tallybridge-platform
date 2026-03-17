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
    name: string // cost centre name (Tally name, without ABBR suffix)
    amount: number // positive amount
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
 *  1. accountMappings (explicit per-ledger mappings — most specific)
 *  2. groupDefaultMappings in reverse + ledgerGroups (e.g. "Sales - B" → "Sales Accounts" → first ledger in that group)
 *  3. Fall back to the ERPNext account name as-is */
function reverseMapAccount(erpAccount: string, config: CompanyConfig): string {
    // 1. Explicit account mappings
    for (const [tally, erp] of Object.entries(config.accountMappings)) {
        if (erp === erpAccount) return tally
    }
    // 2. Group default mappings in reverse: find which Tally group this ERPNext account
    //    was derived from, then find the first Tally ledger in that group
    if (config.groupDefaultMappings && config.ledgerGroups) {
        for (const [group, defaultErpAccount] of Object.entries(config.groupDefaultMappings)) {
            if (defaultErpAccount === erpAccount) {
                for (const [tallyLedger, tallyGroup] of Object.entries(config.ledgerGroups)) {
                    if (tallyGroup === group) return tallyLedger
                }
            }
        }
    }
    // 3. Strip ERPNext company abbreviation suffix (e.g. "Output Tax SGST - B" → "Output Tax SGST")
    //    ERPNext appends " - ABBR" to all accounts; Tally uses the name without it.
    if (config.erpnextAbbr) {
        const suffix = ` - ${config.erpnextAbbr}`
        if (erpAccount.endsWith(suffix)) return erpAccount.slice(0, -suffix.length)
    }
    // 4. Return as-is (last resort)
    return erpAccount
}
