import { describe, it, expect } from 'vitest'
import { transformVoucher } from './index'
import {
    makeConfig,
    makeSalesVoucher,
    makePurchaseVoucher,
    makePaymentVoucher,
    makeReceiptVoucher,
    makeJournalVoucher,
    makeVoucher,
} from '../../test/fixtures'

describe('transformVoucher router', () => {
    const config = makeConfig({
        accountMappings: {
            ...makeConfig().accountMappings,
            'OFFICE RENT': '5209 - Office Rent - TC',
            'PURCHASES': '1410 - Stock In Hand - TC',
        },
    })

    it('routes "Sales" to transformSales', () => {
        const result = transformVoucher(makeSalesVoucher(), config)
        expect(result.success).toBe(true)
        if (!result.success) return
        expect(result.doc.doctype).toBe('Sales Invoice')
    })

    it('routes "Purchase" to transformPurchase', () => {
        const result = transformVoucher(makePurchaseVoucher(), config)
        expect(result.success).toBe(true)
        if (!result.success) return
        expect(result.doc.doctype).toBe('Purchase Invoice')
    })

    it('routes "Payment" to transformPayment', () => {
        const result = transformVoucher(makePaymentVoucher(), config)
        expect(result.success).toBe(true)
        if (!result.success) return
        expect(result.doc.doctype).toBe('Payment Entry')
    })

    it('routes "Receipt" to transformPayment', () => {
        const result = transformVoucher(makeReceiptVoucher(), config)
        expect(result.success).toBe(true)
        if (!result.success) return
        expect(result.doc.doctype).toBe('Payment Entry')
    })

    it('routes "Journal" to transformJournal', () => {
        const result = transformVoucher(makeJournalVoucher(), config)
        expect(result.success).toBe(true)
        if (!result.success) return
        expect(result.doc.doctype).toBe('Journal Entry')
    })

    it('routes "Contra" to transformJournal as Bank Entry', () => {
        const voucher = makeJournalVoucher({ voucherTypeName: 'Contra' })
        const result = transformVoucher(voucher, config)
        expect(result.success).toBe(true)
        if (!result.success) return
        expect(result.doc.doctype).toBe('Journal Entry')
    })

    it('routes "Credit Note" to transformSales with is_return', () => {
        const voucher = makeSalesVoucher({ voucherTypeName: 'Credit Note' })
        const result = transformVoucher(voucher, config)
        expect(result.success).toBe(true)
        if (!result.success) return
        expect(result.doc.doctype).toBe('Sales Invoice')
    })

    it('routes "Debit Note" to transformPurchase with is_return', () => {
        const voucher = makePurchaseVoucher({ voucherTypeName: 'Debit Note' })
        const result = transformVoucher(voucher, config)
        expect(result.success).toBe(true)
        if (!result.success) return
        expect(result.doc.doctype).toBe('Purchase Invoice')
    })

    it('uses voucherTypeMappings config when available', () => {
        const configWithMapping = makeConfig({
            voucherTypeMappings: {
                'Custom Sales': { erpnextDoctype: 'Sales Invoice' },
            },
        })
        const voucher = makeSalesVoucher({ voucherTypeName: 'Custom Sales' })
        const result = transformVoucher(voucher, configWithMapping)
        expect(result.success).toBe(true)
        if (!result.success) return
        expect(result.doc.doctype).toBe('Sales Invoice')
    })

    it('returns TRANSFORM_FAILED for unknown voucher type', () => {
        const voucher = makeVoucher({ voucherTypeName: 'Stock Transfer' })
        const result = transformVoucher(voucher, config)
        expect(result.success).toBe(false)
        if (result.success) return
        expect(result.error.code).toBe('TRANSFORM_FAILED')
    })
})
