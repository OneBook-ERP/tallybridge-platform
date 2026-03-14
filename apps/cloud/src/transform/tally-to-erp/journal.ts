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

        // Party ledger? Attach party details — but ONLY on Receivable/Payable accounts.
        // ERPNext rejects party on non-Receivable/Payable accounts.
        if (le.isPartyLedger || resolved.isPartyFallback) {
            const acctLower = resolved.account.toLowerCase()
            const isReceivablePayable =
                acctLower.includes('debtor') ||
                acctLower.includes('creditor') ||
                acctLower.includes('receivable') ||
                acctLower.includes('payable')
            if (isReceivablePayable) {
                const partyName =
                    voucher.partyLedgerName && le.ledgerName !== voucher.partyLedgerName
                        ? voucher.partyLedgerName
                        : le.ledgerName
                jAccount.party = sanitiseName(partyName)
                jAccount.party_type = le.isDeemedPositive ? 'Customer' : 'Supplier'
            }
        }

        accounts.push(jAccount)
    }

    if (accounts.length === 0) {
        return {
            success: false,
            error: { code: 'TRANSFORM_FAILED', message: 'Journal has no valid ledger entries after filtering' },
        }
    }

    // Balance rounding difference — ERPNext requires exact debit == credit
    const roundedDebit = roundInr(totalDebit)
    const roundedCredit = roundInr(totalCredit)
    const diff = roundInr(roundedDebit - roundedCredit)
    if (diff !== 0 && Math.abs(diff) <= 1) {
        // Small rounding difference — adjust the larger side
        if (diff > 0) {
            // Debit is larger — add credit adjustment to last credit entry
            const lastCredit = [...accounts].reverse().find((a) => a.credit_in_account_currency > 0)
            if (lastCredit) lastCredit.credit_in_account_currency = roundInr(lastCredit.credit_in_account_currency + diff)
        } else {
            // Credit is larger — add debit adjustment to last debit entry
            const lastDebit = [...accounts].reverse().find((a) => a.debit_in_account_currency > 0)
            if (lastDebit) lastDebit.debit_in_account_currency = roundInr(lastDebit.debit_in_account_currency - diff)
        }
        warnings.push(`Adjusted rounding difference of ₹${Math.abs(diff)} to balance journal`)
    }

    let balancedDebit = roundInr(accounts.reduce((s, a) => s + a.debit_in_account_currency, 0))
    let balancedCredit = roundInr(accounts.reduce((s, a) => s + a.credit_in_account_currency, 0))

    // Final safety: if floating-point summation still leaves a tiny diff, force-align
    if (balancedDebit !== balancedCredit && Math.abs(balancedDebit - balancedCredit) <= 1) {
        const max = Math.max(balancedDebit, balancedCredit)
        balancedDebit = max
        balancedCredit = max
    }

    const doc: ERPNextJournalEntry = {
        doctype: 'Journal Entry',
        voucher_type: voucherType,
        posting_date: tallyDateToErp(voucher.date),
        company: config.erpnextCompany,
        user_remark: voucher.narration || undefined,
        accounts,
        total_debit: balancedDebit,
        total_credit: balancedCredit,
        company_gstin: config.companyGstin || undefined,
        custom_tally_guid: voucher.guid,
        custom_tally_voucher_number: voucher.voucherNumber,
        custom_sync_source: 'TALLYBRIDGE',
    }

    return { success: true, doc, warnings }
}
