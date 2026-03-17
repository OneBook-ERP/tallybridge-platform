/**
 * Tests for ERPNext Purchase Invoice → Tally Purchase Voucher transform.
 */
import { describe, it, expect } from 'vitest'
import { erpPurchaseToTally } from './purchase'
import { makeConfig, makeERPNextPurchaseInvoice } from '../../test/fixtures'

describe('erpPurchaseToTally', () => {
    const config = makeConfig()

    it('produces voucherType=Purchase, isInvoice=true', () => {
        const doc = makeERPNextPurchaseInvoice()
        const result = erpPurchaseToTally(doc, config)

        expect(result.voucherType).toBe('Purchase')
        expect(result.isInvoice).toBe(true)
        expect(result.action).toBe('CREATE')
    })

    it('expense items are Dr entries (positive amounts)', () => {
        const doc = makeERPNextPurchaseInvoice()
        const result = erpPurchaseToTally(doc, config)

        const expenseEntry = result.ledgerEntries[0]
        expect(expenseEntry.isDeemedPositive).toBe(true)
        expect(expenseEntry.amount).toBe(310000)
    })

    it('input tax entries are Dr', () => {
        const doc = makeERPNextPurchaseInvoice()
        const result = erpPurchaseToTally(doc, config)

        const cgst = result.ledgerEntries[1]
        const sgst = result.ledgerEntries[2]
        expect(cgst.isDeemedPositive).toBe(true)
        expect(cgst.amount).toBe(27900)
        expect(sgst.isDeemedPositive).toBe(true)
        expect(sgst.amount).toBe(27900)
    })

    it('supplier is Cr entry with bill allocation', () => {
        const doc = makeERPNextPurchaseInvoice()
        const result = erpPurchaseToTally(doc, config)

        const supplierEntry = result.ledgerEntries[result.ledgerEntries.length - 1]
        expect(supplierEntry.ledgerName).toBe('SERVO PACKAGING LIMITED')
        expect(supplierEntry.isDeemedPositive).toBe(false)
        expect(supplierEntry.isPartyLedger).toBe(true)
        expect(supplierEntry.amount).toBe(-822500)
        expect(supplierEntry.billAllocations[0].billType).toBe('New Ref')
    })

    it('referenceNumber from bill_no', () => {
        const doc = makeERPNextPurchaseInvoice({ bill_no: 'SUP-INV-001' })
        const result = erpPurchaseToTally(doc, config)

        expect(result.referenceNumber).toBe('SUP-INV-001')
    })

    it('bill_date converted to dueDate via erpDateToTally', () => {
        const doc = makeERPNextPurchaseInvoice({ bill_date: '2024-03-28' })
        const result = erpPurchaseToTally(doc, config)

        const supplierEntry = result.ledgerEntries[result.ledgerEntries.length - 1]
        expect(supplierEntry.billAllocations[0].dueDate).toBe('20240328')
    })

    it('missing bill_no falls back to BILL-REF', () => {
        const doc = makeERPNextPurchaseInvoice({ bill_no: undefined })
        const result = erpPurchaseToTally(doc, config)

        const supplierEntry = result.ledgerEntries[result.ledgerEntries.length - 1]
        expect(supplierEntry.billAllocations[0].name).toBe('BILL-REF')
    })
})
