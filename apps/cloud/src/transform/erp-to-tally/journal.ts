/**
 * Step 14 — ERPNext Journal Entry → Tally Journal/Contra Voucher data.
 */
import type { ERPNextJournalEntry, CompanyConfig } from '../../types'
import { erpDateToTally, roundInr } from '../utils'
import type { TallyVoucherInput, TallyLedgerEntryInput } from './sales'

/** Format a cost centre name for Tally: strip ERPNext " - ABBR" suffix. */
function formatCostCentre(costCenter: string): string {
    return costCenter.replace(/\s*-\s*[A-Z0-9]+$/, '').trim()
}

export function erpJournalToTally(
    doc: ERPNextJournalEntry,
    config: CompanyConfig,
    action: 'CREATE' | 'ALTER' | 'CANCEL' = 'CREATE',
): TallyVoucherInput {
    const isContra = doc.voucher_type === 'Bank Entry' || doc.voucher_type === 'Contra Entry'
    const voucherType = isContra ? 'Contra' : 'Journal'

    const ledgerEntries: TallyLedgerEntryInput[] = doc.accounts.map((acct) => {
        const isDebit = acct.debit_in_account_currency > 0
        const amount = roundInr(isDebit ? acct.debit_in_account_currency : acct.credit_in_account_currency)
        const tallyLedger = reverseMapAccount(acct.account, config)

        // Cost centre allocation: if ERPNext journal line has a cost_center, write it to Tally
        const costCentreAllocations =
            acct.cost_center
                ? [{ name: formatCostCentre(acct.cost_center), amount }]
                : undefined

        return {
            ledgerName: tallyLedger,
            isDeemedPositive: isDebit,
            isPartyLedger: !!acct.party,
            amount: isDebit ? amount : -amount,
            billAllocations: [],
            costCentreAllocations,
        }
    })

    return {
        action,
        guid: doc.custom_tally_guid ?? `ERP-${doc.name}`,
        voucherType,
        objView: 'Accounting Voucher View',
        date: erpDateToTally(doc.posting_date),
        voucherNumber: doc.name ?? '',
        partyLedgerName: '',
        narration: doc.user_remark,
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
