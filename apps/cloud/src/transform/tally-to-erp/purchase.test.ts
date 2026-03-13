import { describe, it, expect } from 'vitest'
import { transformPurchase } from './purchase'
import { makeConfig, makePurchaseVoucher, makeLedgerEntry } from '../../test/fixtures'

describe('transformPurchase', () => {
    const config = makeConfig()

    it('transforms a basic intra-state purchase voucher', () => {
        const voucher = makePurchaseVoucher()
        const result = transformPurchase(voucher, config)

        expect(result.success).toBe(true)
        if (!result.success) return

        expect(result.doc.doctype).toBe('Purchase Invoice')
        expect(result.doc.supplier).toBe('Supplier XYZ')
        expect(result.doc.posting_date).toBe('2024-04-01')
        expect(result.doc.is_return).toBe(0)
        expect(result.doc.is_inter_state).toBe(0)
        expect(result.doc.gst_category).toBe('Registered Regular')
        expect(result.doc.custom_tally_guid).toBe('test-guid-001')
    })

    it('detects debit note as return', () => {
        const voucher = makePurchaseVoucher({ voucherTypeName: 'Debit Note' })
        const result = transformPurchase(voucher, config)

        expect(result.success).toBe(true)
        if (!result.success) return
        expect(result.doc.is_return).toBe(1)
    })

    it('uses reference number as bill_no when available', () => {
        const voucher = makePurchaseVoucher({ referenceNumber: 'SUP-INV-123' })
        const result = transformPurchase(voucher, config)

        expect(result.success).toBe(true)
        if (!result.success) return
        expect(result.doc.bill_no).toBe('SUP-INV-123')
    })

    it('falls back to voucher number when no reference number', () => {
        const voucher = makePurchaseVoucher({ referenceNumber: '' })
        const result = transformPurchase(voucher, config)

        expect(result.success).toBe(true)
        if (!result.success) return
        expect(result.doc.bill_no).toBe('PI-001')
    })

    it('builds items from inventory entries', () => {
        const voucher = makePurchaseVoucher()
        const result = transformPurchase(voucher, config)

        expect(result.success).toBe(true)
        if (!result.success) return

        expect(result.doc.items).toHaveLength(1)
        expect(result.doc.items[0].item_code).toBe('Widget A')
        expect(result.doc.items[0].expense_account).toBe('Cost of Goods Sold - TC')
    })

    it('builds service purchase from ledger entries when no inventory', () => {
        const voucher = makePurchaseVoucher({
            inventoryEntries: [],
            ledgerEntries: [
                makeLedgerEntry({
                    ledgerName: 'Supplier XYZ',
                    isPartyLedger: true,
                    isDeemedPositive: false,
                    amount: -10000,
                }),
                makeLedgerEntry({ ledgerName: 'B2B Purchase', isDeemedPositive: true, amount: 10000 }),
            ],
        })
        const result = transformPurchase(voucher, config)

        expect(result.success).toBe(true)
        if (!result.success) return
        expect(result.doc.items).toHaveLength(1)
        expect(result.doc.items[0].item_code).toBe('B2B Purchase')
    })

    it('calculates totals correctly', () => {
        const voucher = makePurchaseVoucher()
        const result = transformPurchase(voucher, config)

        expect(result.success).toBe(true)
        if (!result.success) return

        expect(result.doc.total).toBe(1000)
        expect(result.doc.total_taxes_and_charges).toBe(1800)
        expect(result.doc.grand_total).toBe(2800)
    })

    it('fails with UNMAPPED_LEDGER for unknown service ledger', () => {
        const voucher = makePurchaseVoucher({
            inventoryEntries: [],
            ledgerEntries: [
                makeLedgerEntry({
                    ledgerName: 'Supplier XYZ',
                    isPartyLedger: true,
                    isDeemedPositive: false,
                    amount: -5000,
                }),
                makeLedgerEntry({ ledgerName: 'Unknown Expense', isDeemedPositive: true, amount: 5000 }),
            ],
        })
        const result = transformPurchase(voucher, config)

        expect(result.success).toBe(false)
        if (result.success) return
        expect(result.error.code).toBe('UNMAPPED_LEDGER')
    })
})
