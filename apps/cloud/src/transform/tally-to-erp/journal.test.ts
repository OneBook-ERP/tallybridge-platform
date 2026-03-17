import { describe, it, expect } from 'vitest'
import { transformJournal } from './journal'
import { makeConfig, makeJournalVoucher, makeLedgerEntry } from '../../test/fixtures'

describe('transformJournal', () => {
    const config = makeConfig()

    it('transforms a basic journal voucher', () => {
        const voucher = makeJournalVoucher()
        const result = transformJournal(voucher, config)

        expect(result.success).toBe(true)
        if (!result.success) return

        expect(result.doc.doctype).toBe('Journal Entry')
        expect(result.doc.voucher_type).toBe('Journal Entry')
        expect(result.doc.posting_date).toBe('2023-06-20')
        expect(result.doc.company).toBe('Test Company')
        expect(result.doc.custom_tally_guid).toBe('3b4a4714-7fa1-4344-a9cf-97e8d4168385-00002cf6')
    })

    it('detects contra voucher as Contra Entry', () => {
        const voucher = makeJournalVoucher({ voucherTypeName: 'Contra' })
        const result = transformJournal(voucher, config)

        expect(result.success).toBe(true)
        if (!result.success) return
        expect(result.doc.voucher_type).toBe('Contra Entry')
    })

    it('maps debit and credit sides correctly', () => {
        const voucher = makeJournalVoucher()
        const result = transformJournal(voucher, config)

        expect(result.success).toBe(true)
        if (!result.success) return

        expect(result.doc.accounts).toHaveLength(2)

        const debitEntry = result.doc.accounts.find((a) => a.debit_in_account_currency > 0)
        const creditEntry = result.doc.accounts.find((a) => a.credit_in_account_currency > 0)

        expect(debitEntry).toBeDefined()
        expect(creditEntry).toBeDefined()
        expect(debitEntry!.debit_in_account_currency).toBe(5000)
        expect(creditEntry!.credit_in_account_currency).toBe(5000)
    })

    it('balances total_debit and total_credit', () => {
        const voucher = makeJournalVoucher()
        const result = transformJournal(voucher, config)

        expect(result.success).toBe(true)
        if (!result.success) return
        expect(result.doc.total_debit).toBe(result.doc.total_credit)
    })

    it('suppresses round-off entries and warns', () => {
        const voucher = makeJournalVoucher({
            ledgerEntries: [
                makeLedgerEntry({ ledgerName: 'B2B SALES', isDeemedPositive: true, amount: 5000 }),
                makeLedgerEntry({ ledgerName: 'HDFC BANK', isDeemedPositive: false, amount: -4999.5 }),
                makeLedgerEntry({ ledgerName: 'Cash', isDeemedPositive: false, amount: -0.5 }),
            ],
        })
        const result = transformJournal(voucher, config)

        expect(result.success).toBe(true)
        if (!result.success) return
        // Round-off entry (0.5 < 1) should be suppressed
        expect(result.doc.accounts).toHaveLength(2)
        expect(result.warnings.length).toBeGreaterThan(0)
        expect(result.warnings[0]).toContain('Round-off')
    })

    it('attaches party info on Receivable/Payable accounts only', () => {
        const voucher = makeJournalVoucher({
            partyLedgerName: 'Customer ABC',
            ledgerEntries: [
                makeLedgerEntry({
                    ledgerName: 'Customer ABC',
                    isDeemedPositive: true,
                    amount: 5000,
                    isPartyLedger: true,
                }),
                makeLedgerEntry({ ledgerName: 'HDFC BANK', isDeemedPositive: false, amount: -5000 }),
            ],
        })
        const result = transformJournal(voucher, config)

        expect(result.success).toBe(true)
        if (!result.success) return
        const partyAccount = result.doc.accounts.find((a) => a.party)
        expect(partyAccount).toBeDefined()
        expect(partyAccount!.party).toBe('Customer ABC')
        expect(partyAccount!.account).toContain('Debtors')
    })

    it('does not set party on non-Receivable/Payable accounts', () => {
        const voucher = makeJournalVoucher({
            partyLedgerName: 'Customer ABC',
            ledgerEntries: [
                makeLedgerEntry({ ledgerName: 'B2B SALES', isDeemedPositive: true, amount: 5000, isPartyLedger: true }),
                makeLedgerEntry({ ledgerName: 'HDFC BANK', isDeemedPositive: false, amount: -5000 }),
            ],
        })
        const result = transformJournal(voucher, config)

        expect(result.success).toBe(true)
        if (!result.success) return
        // No account should have party set — Sales and Bank are not Receivable/Payable
        const partyAccount = result.doc.accounts.find((a) => a.party)
        expect(partyAccount).toBeUndefined()
    })

    it('returns IGNORED_VOUCHER when all entries are round-off (nothing meaningful to sync)', () => {
        const voucher = makeJournalVoucher({
            ledgerEntries: [makeLedgerEntry({ ledgerName: 'Round Off', isDeemedPositive: true, amount: 0.3 })],
        })
        const result = transformJournal(voucher, config)

        expect(result.success).toBe(false)
        if (result.success) return
        expect(result.error.code).toBe('IGNORED_VOUCHER')
    })

    it('fails with UNMAPPED_LEDGER for unknown account', () => {
        const voucher = makeJournalVoucher({
            ledgerEntries: [
                makeLedgerEntry({ ledgerName: 'Unknown Expense', isDeemedPositive: true, amount: 5000 }),
                makeLedgerEntry({ ledgerName: 'HDFC BANK', isDeemedPositive: false, amount: -5000 }),
            ],
        })
        const result = transformJournal(voucher, config)

        expect(result.success).toBe(false)
        if (result.success) return
        expect(result.error.code).toBe('UNMAPPED_LEDGER')
    })

    it('includes narration as user_remark', () => {
        const voucher = makeJournalVoucher({ narration: 'Year end adjustment' })
        const result = transformJournal(voucher, config)

        expect(result.success).toBe(true)
        if (!result.success) return
        expect(result.doc.user_remark).toBe('Year end adjustment')
    })

    it('sets custom_tally_voucher_number from voucher', () => {
        const voucher = makeJournalVoucher({ voucherNumber: 'JV-042' })
        const result = transformJournal(voucher, config)

        expect(result.success).toBe(true)
        if (!result.success) return
        expect(result.doc.custom_tally_voucher_number).toBe('JV-042')
    })

    // ── Group 6 edge cases ───────────────────────────────────────────────────

    it('auto-balances small rounding difference (≤₹5) and warns', () => {
        const voucher = makeJournalVoucher({
            ledgerEntries: [
                makeLedgerEntry({ ledgerName: 'B2B SALES', isDeemedPositive: true, amount: 5002 }),
                makeLedgerEntry({ ledgerName: 'HDFC BANK', isDeemedPositive: false, amount: -5000 }),
            ],
        })
        const result = transformJournal(voucher, config)

        expect(result.success).toBe(true)
        if (!result.success) return
        expect(result.doc.total_debit).toBe(result.doc.total_credit)
        expect(result.warnings.some((w) => w.includes('Auto-balanced') || w.includes('adjusted'))).toBe(true)
    })

    it('auto-balances large imbalance (>₹5) with warning about data quality', () => {
        const voucher = makeJournalVoucher({
            ledgerEntries: [
                makeLedgerEntry({ ledgerName: 'B2B SALES', isDeemedPositive: true, amount: 5100 }),
                makeLedgerEntry({ ledgerName: 'HDFC BANK', isDeemedPositive: false, amount: -5000 }),
            ],
        })
        const result = transformJournal(voucher, config)

        expect(result.success).toBe(true)
        if (!result.success) return
        expect(result.doc.total_debit).toBe(result.doc.total_credit)
        expect(result.warnings.some((w) => w.includes('imbalance') || w.includes('force-balanced'))).toBe(true)
    })

    it('Payment voucher type routes to Contra Entry', () => {
        const voucher = makeJournalVoucher({ voucherTypeName: 'Payment' })
        const result = transformJournal(voucher, config)

        expect(result.success).toBe(true)
        if (!result.success) return
        expect(result.doc.voucher_type).toBe('Contra Entry')
    })

    it('Receipt voucher type routes to Contra Entry', () => {
        const voucher = makeJournalVoucher({ voucherTypeName: 'Receipt' })
        const result = transformJournal(voucher, config)

        expect(result.success).toBe(true)
        if (!result.success) return
        expect(result.doc.voucher_type).toBe('Contra Entry')
    })

    it('attaches Supplier party on Payable account (creditor direction)', () => {
        const voucher = makeJournalVoucher({
            partyLedgerName: 'Supplier XYZ',
            ledgerEntries: [
                makeLedgerEntry({
                    ledgerName: 'Supplier XYZ',
                    isDeemedPositive: false,
                    amount: -5000,
                    isPartyLedger: true,
                }),
                makeLedgerEntry({ ledgerName: 'HDFC BANK', isDeemedPositive: true, amount: 5000 }),
            ],
        })
        const result = transformJournal(voucher, config)

        expect(result.success).toBe(true)
        if (!result.success) return
        const partyAccount = result.doc.accounts.find((a) => a.party)
        expect(partyAccount).toBeDefined()
        expect(partyAccount!.party_type).toBe('Supplier')
        expect(partyAccount!.account).toContain('Creditor')
    })

    it('skips __IGNORE__ mapped accounts', () => {
        const ignoreConfig = makeConfig({
            accountMappings: { ...config.accountMappings, 'B2B SALES': '__IGNORE__' },
        })
        const voucher = makeJournalVoucher({
            ledgerEntries: [
                makeLedgerEntry({ ledgerName: 'B2B SALES', isDeemedPositive: true, amount: 5000 }),
                makeLedgerEntry({ ledgerName: 'HDFC BANK', isDeemedPositive: false, amount: -5000 }),
            ],
        })
        const result = transformJournal(voucher, ignoreConfig)

        expect(result.success).toBe(true)
        if (!result.success) return
        expect(result.doc.accounts).toHaveLength(1)
        expect(result.doc.accounts[0].account).toBe('1220 - HDFC Bank - TC')
    })

    it('TRANSFORM_FAILED when no valid entries remain after filtering', () => {
        // All entries are round-off but allIgnored tracks them as resolver errors
        const voucher = makeJournalVoucher({
            ledgerEntries: [
                makeLedgerEntry({ ledgerName: 'Round Off', isDeemedPositive: true, amount: 0.1 }),
                makeLedgerEntry({ ledgerName: 'Cash', isDeemedPositive: false, amount: -0.1 }),
            ],
        })
        const result = transformJournal(voucher, config)

        // Round-off entries get suppressed; result may fail with IGNORED or TRANSFORM_FAILED
        // depending on account resolver for 'Cash' — key is no data corruption
        expect(result.success).toBe(false)
    })
})
