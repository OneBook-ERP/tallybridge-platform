/**
 * Step 13 — Tally Journal/Contra → ERPNext Journal Entry
 */
import type { TallyVoucher, CompanyConfig, ERPNextJournalEntry, JournalAccount, TransformResult } from '../../types'
import { resolveAccount, isTransformError } from '../account-resolver'
import { tallyDateToErp, absAmount, roundInr, sanitiseName, isRoundOff } from '../utils'

export function transformJournal(voucher: TallyVoucher, config: CompanyConfig): TransformResult<ERPNextJournalEntry> {
    const isContra = voucher.voucherTypeName.toLowerCase() === 'contra'
    const voucherType = isContra ? 'Bank Entry' : 'Journal Entry'

    const accounts: JournalAccount[] = []
    const warnings: string[] = []
    let totalDebit = 0,
        totalCredit = 0

    for (const le of voucher.ledgerEntries) {
        // Skip round-off entries (Tier 1 auto-correct)
        if (isRoundOff(le.amount)) {
            warnings.push(`Round-off entry on "${le.ledgerName}" suppressed (₹${Math.abs(le.amount)})`)
            continue
        }

        // Pass party hint so resolver can fall back to Debtors/Creditors
        const resolved = resolveAccount(le.ledgerName, config, {
            isPartyLedger: le.isPartyLedger,
            partyDirection: le.isDeemedPositive ? 'debtor' : 'creditor',
            partyLedgerName: voucher.partyLedgerName,
        })
        if (isTransformError(resolved)) {
            if (resolved.code === 'UNMAPPED_LEDGER') return { success: false, error: resolved }
            continue
        }
        if (resolved.isRoundOff) continue
        if (resolved.account === '__IGNORE__') continue

        const amt = roundInr(absAmount(le.amount))

        // Tally: isDeemedPositive=true means Debit for that ledger
        const dr = le.isDeemedPositive ? amt : 0
        const cr = le.isDeemedPositive ? 0 : amt
        totalDebit += dr
        totalCredit += cr

        const jAccount: JournalAccount = {
            account: resolved.account,
            debit_in_account_currency: dr,
            credit_in_account_currency: cr,
        }

        // Party ledger? Attach party details for sub-ledger tracking
        if (le.isPartyLedger || resolved.isPartyFallback) {
            // Prefer voucher-level partyLedgerName when the entry's ledger is an
            // account (e.g. "B2B Sales") rather than the actual party name.
            const partyName =
                voucher.partyLedgerName && le.ledgerName !== voucher.partyLedgerName
                    ? voucher.partyLedgerName
                    : le.ledgerName
            jAccount.party = sanitiseName(partyName)
            jAccount.party_type = le.isDeemedPositive ? 'Customer' : 'Supplier'
        }

        accounts.push(jAccount)
    }

    if (accounts.length === 0) {
        return {
            success: false,
            error: { code: 'TRANSFORM_FAILED', message: 'Journal has no valid ledger entries after filtering' },
        }
    }

    const doc: ERPNextJournalEntry = {
        doctype: 'Journal Entry',
        voucher_type: voucherType,
        posting_date: tallyDateToErp(voucher.date),
        company: config.erpnextCompany,
        user_remark: voucher.narration || undefined,
        accounts,
        total_debit: roundInr(totalDebit),
        total_credit: roundInr(totalCredit),
        custom_tally_guid: voucher.guid,
        custom_sync_source: 'TALLYBRIDGE',
    }

    return { success: true, doc, warnings }
}
