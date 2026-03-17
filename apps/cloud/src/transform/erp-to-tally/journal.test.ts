/**
 * Tests for ERPNext Journal Entry → Tally Journal/Contra Voucher transform.
 */
import { describe, it, expect } from 'vitest'
import { erpJournalToTally } from './journal'
import { makeConfig, makeERPNextJournalEntry } from '../../test/fixtures'

describe('erpJournalToTally', () => {
    const config = makeConfig()

    it('Journal Entry → voucherType=Journal', () => {
        const doc = makeERPNextJournalEntry({ voucher_type: 'Journal Entry' })
        const result = erpJournalToTally(doc, config)

        expect(result.voucherType).toBe('Journal')
        expect(result.isInvoice).toBe(false)
    })

    it('Bank Entry → voucherType=Contra', () => {
        const doc = makeERPNextJournalEntry({ voucher_type: 'Bank Entry' })
        const result = erpJournalToTally(doc, config)
        expect(result.voucherType).toBe('Contra')
    })

    it('Contra Entry → voucherType=Contra', () => {
        const doc = makeERPNextJournalEntry({ voucher_type: 'Contra Entry' })
        const result = erpJournalToTally(doc, config)
        expect(result.voucherType).toBe('Contra')
    })

    it('debit entries have isDeemedPositive=true with positive amount', () => {
        const doc = makeERPNextJournalEntry()
        const result = erpJournalToTally(doc, config)

        const debitEntry = result.ledgerEntries[0] // 4110 - Sales - TC, debit=14904
        expect(debitEntry.isDeemedPositive).toBe(true)
        expect(debitEntry.amount).toBe(14904)
    })

    it('credit entries have isDeemedPositive=false with negative amount', () => {
        const doc = makeERPNextJournalEntry()
        const result = erpJournalToTally(doc, config)

        const creditEntry = result.ledgerEntries[1] // 1220 - HDFC Bank - TC, credit=14904
        expect(creditEntry.isDeemedPositive).toBe(false)
        expect(creditEntry.amount).toBe(-14904)
    })

    it('accounts with party have isPartyLedger=true', () => {
        const doc = makeERPNextJournalEntry({
            accounts: [
                { account: 'Debtors - TC', debit_in_account_currency: 5000, credit_in_account_currency: 0, party_type: 'Customer', party: 'Customer ABC' },
                { account: 'Sales - TC', debit_in_account_currency: 0, credit_in_account_currency: 5000 },
            ],
        })
        const result = erpJournalToTally(doc, config)

        expect(result.ledgerEntries[0].isPartyLedger).toBe(true)
        expect(result.ledgerEntries[1].isPartyLedger).toBe(false)
    })

    it('narration comes from user_remark', () => {
        const doc = makeERPNextJournalEntry({ user_remark: 'Year-end closing' })
        const result = erpJournalToTally(doc, config)

        expect(result.narration).toBe('Year-end closing')
    })
})
