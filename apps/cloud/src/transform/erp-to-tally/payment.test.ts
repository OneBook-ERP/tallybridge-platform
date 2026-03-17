/**
 * Tests for ERPNext Payment Entry → Tally Payment/Receipt Voucher transform.
 */
import { describe, it, expect } from 'vitest'
import { erpPaymentToTally } from './payment'
import { makeConfig, makeERPNextPaymentEntry } from '../../test/fixtures'

describe('erpPaymentToTally', () => {
    const config = makeConfig()

    it('Receive → voucherType=Receipt, bank Dr, customer Cr', () => {
        const doc = makeERPNextPaymentEntry({ payment_type: 'Receive' })
        const result = erpPaymentToTally(doc, config)

        expect(result.voucherType).toBe('Receipt')
        // First entry: bank Dr
        expect(result.ledgerEntries[0].isDeemedPositive).toBe(true)
        expect(result.ledgerEntries[0].isPartyLedger).toBe(false)
        // Second entry: customer Cr
        expect(result.ledgerEntries[1].isDeemedPositive).toBe(false)
        expect(result.ledgerEntries[1].isPartyLedger).toBe(true)
        expect(result.ledgerEntries[1].ledgerName).toBe('HDFC BANK')
    })

    it('Pay → voucherType=Payment, supplier Dr, bank Cr', () => {
        const doc = makeERPNextPaymentEntry({
            payment_type: 'Pay',
            party_type: 'Supplier',
            party: 'Supplier XYZ',
            paid_from: 'Bank Account - TC',
            paid_to: 'Creditors - TC',
            references: [],
        })
        const result = erpPaymentToTally(doc, config)

        expect(result.voucherType).toBe('Payment')
        // First entry: supplier Dr
        expect(result.ledgerEntries[0].isDeemedPositive).toBe(true)
        expect(result.ledgerEntries[0].isPartyLedger).toBe(true)
        // Second entry: bank Cr
        expect(result.ledgerEntries[1].isDeemedPositive).toBe(false)
        expect(result.ledgerEntries[1].isPartyLedger).toBe(false)
    })

    it('bank account from paid_to (receipt) / paid_from (payment)', () => {
        const receipt = makeERPNextPaymentEntry({ payment_type: 'Receive', paid_to: 'Bank Account - TC' })
        const r1 = erpPaymentToTally(receipt, config)
        expect(r1.ledgerEntries[0].ledgerName).toBe('Bank Account - TC')

        const payment = makeERPNextPaymentEntry({
            payment_type: 'Pay',
            paid_from: 'Cash - TC',
            party_type: 'Supplier',
            party: 'Supplier XYZ',
            references: [],
        })
        const r2 = erpPaymentToTally(payment, config)
        // Bank Cr is second entry for payment
        expect(r2.ledgerEntries[1].ledgerName).toBe('Cash - TC')
    })

    it('references become Agst Ref bill allocations', () => {
        const doc = makeERPNextPaymentEntry({
            payment_type: 'Receive',
            references: [
                { reference_doctype: 'Sales Invoice', reference_name: 'SINV-001', allocated_amount: 500 },
                { reference_doctype: 'Sales Invoice', reference_name: 'SINV-002', allocated_amount: 680 },
            ],
        })
        const result = erpPaymentToTally(doc, config)

        const partyEntry = result.ledgerEntries[1] // customer Cr for receipt
        expect(partyEntry.billAllocations).toHaveLength(2)
        expect(partyEntry.billAllocations[0].billType).toBe('Agst Ref')
        expect(partyEntry.billAllocations[0].name).toBe('SINV-001')
    })

    it('receipt bill allocation amounts are negative', () => {
        const doc = makeERPNextPaymentEntry({
            payment_type: 'Receive',
            references: [{ reference_doctype: 'Sales Invoice', reference_name: 'SINV-001', allocated_amount: 500 }],
        })
        const result = erpPaymentToTally(doc, config)

        const partyEntry = result.ledgerEntries[1]
        expect(partyEntry.billAllocations[0].amount).toBeLessThan(0)
    })

    it('payment bill allocation amounts are positive', () => {
        const doc = makeERPNextPaymentEntry({
            payment_type: 'Pay',
            party_type: 'Supplier',
            party: 'Supplier XYZ',
            paid_from: 'Bank Account - TC',
            paid_to: 'Creditors - TC',
            references: [{ reference_doctype: 'Purchase Invoice', reference_name: 'PINV-001', allocated_amount: 1180 }],
        })
        const result = erpPaymentToTally(doc, config)

        const partyEntry = result.ledgerEntries[0] // supplier Dr for payment
        expect(partyEntry.billAllocations[0].amount).toBeGreaterThan(0)
    })

    it('isPartyLedger flags correct on both entries', () => {
        const doc = makeERPNextPaymentEntry()
        const result = erpPaymentToTally(doc, config)

        // Default is Pay: entries[0] = party Dr, entries[1] = bank Cr
        const partyEntry = result.ledgerEntries[0]
        const bankEntry = result.ledgerEntries[1]
        expect(bankEntry.isPartyLedger).toBe(false)
        expect(partyEntry.isPartyLedger).toBe(true)
    })

    it('isInvoice is always false', () => {
        const doc = makeERPNextPaymentEntry()
        const result = erpPaymentToTally(doc, config)

        expect(result.isInvoice).toBe(false)
    })

    it('no references → empty bill allocations', () => {
        const doc = makeERPNextPaymentEntry({ references: [] })
        const result = erpPaymentToTally(doc, config)

        // Default is Pay: party entry is at index 0
        const partyEntry = result.ledgerEntries[0]
        expect(partyEntry.billAllocations).toHaveLength(0)
    })
})
