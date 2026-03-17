/**
 * Step 14 — ERPNext Payment Entry → Tally Payment/Receipt Voucher data.
 */
import type { ERPNextPaymentEntry, CompanyConfig } from '../../types'
import { erpDateToTally, roundInr } from '../utils'
import type { TallyVoucherInput, TallyLedgerEntryInput } from './sales'

export function erpPaymentToTally(
    doc: ERPNextPaymentEntry,
    config: CompanyConfig,
    action: 'CREATE' | 'ALTER' | 'CANCEL' = 'CREATE',
): TallyVoucherInput {
    const isReceipt = doc.payment_type === 'Receive'
    const voucherType = isReceipt ? 'Receipt' : 'Payment'
    const amount = roundInr(doc.paid_amount)

    // Resolve bank account (reverse from ERP account name)
    const bankAccount = isReceipt ? doc.paid_to : doc.paid_from
    const tallyBank = reverseMapAccount(bankAccount, config)

    const ledgerEntries: TallyLedgerEntryInput[] = []

    // Build bill allocations: combine Agst Ref (invoice references) + Advance entries
    const buildBillAllocations = (
        isPayment: boolean,
    ): Array<{ name: string; billType: 'Agst Ref' | 'Advance'; amount: number }> => {
        const allocs: Array<{ name: string; billType: 'Agst Ref' | 'Advance'; amount: number }> = []

        // Regular invoice references
        for (const r of doc.references) {
            allocs.push({
                name: r.reference_name,
                billType: 'Agst Ref' as const,
                amount: isPayment ? r.allocated_amount : -r.allocated_amount,
            })
        }

        // Advance payment entries → BILLTYPE Advance
        for (const adv of doc.advance_payment_entries ?? []) {
            allocs.push({
                name: adv.reference_name,
                billType: 'Advance' as const,
                amount: isPayment ? adv.allocated_amount : -adv.allocated_amount,
            })
        }

        return allocs
    }

    if (isReceipt) {
        // Cash/Bank Dr
        ledgerEntries.push({
            ledgerName: tallyBank,
            isDeemedPositive: true,
            isPartyLedger: false,
            amount,
            billAllocations: [],
        })
        // Customer Cr with Agst Ref / Advance bill allocations
        ledgerEntries.push({
            ledgerName: doc.party,
            isDeemedPositive: false,
            isPartyLedger: true,
            amount: -amount,
            billAllocations: buildBillAllocations(false),
        })
    } else {
        // Supplier Dr with Agst Ref / Advance
        ledgerEntries.push({
            ledgerName: doc.party,
            isDeemedPositive: true,
            isPartyLedger: true,
            amount,
            billAllocations: buildBillAllocations(true),
        })
        // Cash/Bank Cr
        ledgerEntries.push({
            ledgerName: tallyBank,
            isDeemedPositive: false,
            isPartyLedger: false,
            amount: -amount,
            billAllocations: [],
        })
    }

    return {
        action,
        guid: doc.custom_tally_guid ?? `ERP-${doc.name}`,
        voucherType,
        objView: 'Accounting Voucher View',
        date: erpDateToTally(doc.posting_date),
        voucherNumber: doc.name ?? '',
        partyLedgerName: doc.party,
        narration: doc.remarks,
        isInvoice: false,
        ledgerEntries,
        inventoryEntries: [],
    }
}

function reverseMapAccount(erpAccount: string, config: CompanyConfig): string {
    for (const [tally, erp] of Object.entries(config.accountMappings)) {
        if (erp === erpAccount) return tally
    }
    return erpAccount
}
