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

    if (isReceipt) {
        // Cash/Bank Dr
        ledgerEntries.push({
            ledgerName: tallyBank,
            isDeemedPositive: true,
            isPartyLedger: false,
            amount,
            billAllocations: [],
        })
        // Customer Cr with Agst Ref bill allocations
        ledgerEntries.push({
            ledgerName: doc.party,
            isDeemedPositive: false,
            isPartyLedger: true,
            amount: -amount,
            billAllocations: doc.references.map((r) => ({
                name: r.reference_name,
                billType: 'Agst Ref' as const,
                amount: -r.allocated_amount,
            })),
        })
    } else {
        // Supplier Dr with Agst Ref
        ledgerEntries.push({
            ledgerName: doc.party,
            isDeemedPositive: true,
            isPartyLedger: true,
            amount,
            billAllocations: doc.references.map((r) => ({
                name: r.reference_name,
                billType: 'Agst Ref' as const,
                amount: r.allocated_amount,
            })),
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
