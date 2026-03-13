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
        expect(result.doc.posting_date).toBe('2024-04-01')
        expect(result.doc.company).toBe('Test Company')
        expect(result.doc.custom_tally_guid).toBe('test-guid-001')
    })

    it('detects contra voucher as Bank Entry', () => {
        const voucher = makeJournalVoucher({ voucherTypeName: 'Contra' })
        const result = transformJournal(voucher, config)

        expect(result.success).toBe(true)
        if (!result.success) return
        expect(result.doc.voucher_type).toBe('Bank Entry')
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
                makeLedgerEntry({ ledgerName: 'B2B Sales', isDeemedPositive: true, amount: 5000 }),
                makeLedgerEntry({ ledgerName: 'Bank Account', isDeemedPositive: false, amount: -4999.5 }),
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

    it('attaches party info for party ledger entries', () => {
        const voucher = makeJournalVoucher({
            partyLedgerName: 'Customer ABC',
            ledgerEntries: [
                makeLedgerEntry({ ledgerName: 'B2B Sales', isDeemedPositive: true, amount: 5000, isPartyLedger: true }),
                makeLedgerEntry({ ledgerName: 'Bank Account', isDeemedPositive: false, amount: -5000 }),
            ],
        })
        const result = transformJournal(voucher, config)

        expect(result.success).toBe(true)
        if (!result.success) return
        const partyAccount = result.doc.accounts.find((a) => a.party)
        expect(partyAccount).toBeDefined()
        expect(partyAccount!.party).toBe('Customer ABC')
    })

    it('fails when all entries are filtered out', () => {
        const voucher = makeJournalVoucher({
            ledgerEntries: [makeLedgerEntry({ ledgerName: 'Round Off', isDeemedPositive: true, amount: 0.3 })],
        })
        const result = transformJournal(voucher, config)

        expect(result.success).toBe(false)
        if (result.success) return
        expect(result.error.code).toBe('TRANSFORM_FAILED')
    })

    it('fails with UNMAPPED_LEDGER for unknown account', () => {
        const voucher = makeJournalVoucher({
            ledgerEntries: [
                makeLedgerEntry({ ledgerName: 'Unknown Expense', isDeemedPositive: true, amount: 5000 }),
                makeLedgerEntry({ ledgerName: 'Bank Account', isDeemedPositive: false, amount: -5000 }),
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
})
