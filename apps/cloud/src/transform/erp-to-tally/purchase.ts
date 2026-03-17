/**
 * Step 14 — ERPNext Purchase Invoice → Tally Purchase Voucher data.
 */
import type { ERPNextPurchaseInvoice, CompanyConfig } from '../../types'
import { erpDateToTally, roundInr } from '../utils'
import type { TallyVoucherInput, TallyLedgerEntryInput, TallyInventoryEntryInput } from './sales'

export function erpPurchaseToTally(
    doc: ERPNextPurchaseInvoice,
    config: CompanyConfig,
    action: 'CREATE' | 'ALTER' | 'CANCEL' = 'CREATE',
): TallyVoucherInput {
    const ledgerEntries: TallyLedgerEntryInput[] = []
    const inventoryEntries: TallyInventoryEntryInput[] = []

    const total = doc.grand_total

    // Purchase expense Dr entries first
    for (const item of doc.items) {
        const tallyLedger = reverseMapAccount(item.expense_account ?? '', config)
        ledgerEntries.push({
            ledgerName: tallyLedger,
            isDeemedPositive: true,
            isPartyLedger: false,
            amount: item.amount,
            billAllocations: [],
        })
        inventoryEntries.push({
            stockItemName: item.item_code,
            rate: item.rate,
            rateUOM: item.uom,
            amount: item.amount,
            billedQty: item.qty,
            billedQtyUOM: item.uom,
            hsnCode: item.gst_hsn_code,
            accountLedger: tallyLedger,
        })
    }

    // GST Dr entries (input tax)
    for (const tax of doc.taxes) {
        const tallyLedger = reverseMapAccount(tax.account_head, config)
        ledgerEntries.push({
            ledgerName: tallyLedger,
            isDeemedPositive: true,
            isPartyLedger: false,
            amount: roundInr(tax.tax_amount),
            billAllocations: [],
        })
    }

    // Supplier Cr entry with bill reference
    ledgerEntries.push({
        ledgerName: doc.supplier,
        isDeemedPositive: false,
        isPartyLedger: true,
        amount: -total,
        billAllocations: [
            {
                name: doc.bill_no ?? 'BILL-REF',
                billType: 'New Ref',
                amount: -total,
                dueDate: doc.bill_date ? erpDateToTally(doc.bill_date) : undefined,
            },
        ],
    })

    return {
        action,
        guid: doc.custom_tally_guid ?? `ERP-${doc.name}`,
        voucherType: 'Purchase',
        objView: 'Accounting Voucher View',
        date: erpDateToTally(doc.posting_date),
        voucherNumber: doc.bill_no ?? doc.name ?? '',
        referenceNumber: doc.bill_no,
        partyLedgerName: doc.supplier,
        narration: doc.remarks,
        isInvoice: true,
        ledgerEntries,
        inventoryEntries,
    }
}

function reverseMapAccount(erpAccount: string, config: CompanyConfig): string {
    for (const [tally, erp] of Object.entries(config.accountMappings)) {
        if (erp === erpAccount) return tally
    }
    return erpAccount
}
