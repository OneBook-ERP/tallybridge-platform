import { describe, it, expect } from 'vitest'
import { transformPayment } from './payment'
import { makeConfig, makePaymentVoucher, makeReceiptVoucher, makeLedgerEntry } from '../../test/fixtures'

describe('transformPayment', () => {
    const config = makeConfig()

    it('transforms a supplier payment voucher', () => {
        const voucher = makePaymentVoucher()
        const result = transformPayment(voucher, config)

        expect(result.success).toBe(true)
        if (!result.success) return

        expect(result.doc.doctype).toBe('Payment Entry')
        expect(result.doc.payment_type).toBe('Pay')
        expect(result.doc.party_type).toBe('Supplier')
        expect(result.doc.party).toBe('Supplier XYZ')
        expect(result.doc.paid_amount).toBe(11800)
        expect(result.doc.received_amount).toBe(11800)
        expect(result.doc.custom_tally_guid).toBe('test-guid-001')
    })

    it('transforms a customer receipt voucher', () => {
        const voucher = makeReceiptVoucher()
        const result = transformPayment(voucher, config)

        expect(result.success).toBe(true)
        if (!result.success) return

        expect(result.doc.payment_type).toBe('Receive')
        expect(result.doc.party_type).toBe('Customer')
        expect(result.doc.party).toBe('Customer ABC')
    })

    it('sets paid_from/paid_to based on receipt vs payment', () => {
        const receipt = makeReceiptVoucher()
        const rResult = transformPayment(receipt, config)
        expect(rResult.success).toBe(true)
        if (!rResult.success) return
        // Receipt: paid_from = Debtors, paid_to = bank
        expect(rResult.doc.paid_from).toContain('Debtors')
        expect(rResult.doc.paid_to).toBe('Bank Account - TC')

        const payment = makePaymentVoucher()
        const pResult = transformPayment(payment, config)
        expect(pResult.success).toBe(true)
        if (!pResult.success) return
        // Payment: paid_from = bank, paid_to = Creditors
        expect(pResult.doc.paid_from).toBe('Bank Account - TC')
        expect(pResult.doc.paid_to).toContain('Creditors')
    })

    it('extracts UTR from bank allocations', () => {
        const voucher = makePaymentVoucher({
            ledgerEntries: [
                makeLedgerEntry({
                    ledgerName: 'Supplier XYZ',
                    isPartyLedger: true,
                    isDeemedPositive: true,
                    amount: 11800,
                    bankAllocations: [{ instNumber: '', uniqueReferenceNumber: 'UTR123456', transactionType: 'NEFT' }],
                }),
                makeLedgerEntry({ ledgerName: 'Bank Account', isDeemedPositive: false, amount: -11800 }),
            ],
        })
        const result = transformPayment(voucher, config)

        expect(result.success).toBe(true)
        if (!result.success) return
        expect(result.doc.reference_no).toBe('UTR123456')
    })

    it('extracts cheque number from bank allocations', () => {
        const voucher = makePaymentVoucher({
            ledgerEntries: [
                makeLedgerEntry({
                    ledgerName: 'Supplier XYZ',
                    isPartyLedger: true,
                    isDeemedPositive: true,
                    amount: 5000,
                    bankAllocations: [{ instNumber: 'CHQ-789', uniqueReferenceNumber: '', transactionType: 'Cheque' }],
                }),
                makeLedgerEntry({ ledgerName: 'Bank Account', isDeemedPositive: false, amount: -5000 }),
            ],
        })
        const result = transformPayment(voucher, config)

        expect(result.success).toBe(true)
        if (!result.success) return
        expect(result.doc.reference_no).toBe('CHQ-789')
    })

    it('builds payment references from Agst Ref bill allocations', () => {
        const voucher = makePaymentVoucher({
            ledgerEntries: [
                makeLedgerEntry({
                    ledgerName: 'Supplier XYZ',
                    isPartyLedger: true,
                    isDeemedPositive: true,
                    amount: 11800,
                    billAllocations: [{ name: 'PI-001', billType: 'Agst Ref', amount: 11800, dueDate: '20240501' }],
                }),
                makeLedgerEntry({ ledgerName: 'Bank Account', isDeemedPositive: false, amount: -11800 }),
            ],
        })
        const result = transformPayment(voucher, config)

        expect(result.success).toBe(true)
        if (!result.success) return
        expect(result.doc.references).toHaveLength(1)
        expect(result.doc.references[0].reference_doctype).toBe('Purchase Invoice')
        expect(result.doc.references[0].reference_name).toBe('PI-001')
        expect(result.doc.references[0].allocated_amount).toBe(11800)
    })

    it('receipt references point to Sales Invoice', () => {
        const voucher = makeReceiptVoucher({
            ledgerEntries: [
                makeLedgerEntry({
                    ledgerName: 'Customer ABC',
                    isPartyLedger: true,
                    isDeemedPositive: false,
                    amount: -11800,
                    billAllocations: [{ name: 'SI-001', billType: 'Agst Ref', amount: -11800, dueDate: '20240501' }],
                }),
                makeLedgerEntry({ ledgerName: 'Bank Account', isDeemedPositive: true, amount: 11800 }),
            ],
        })
        const result = transformPayment(voucher, config)

        expect(result.success).toBe(true)
        if (!result.success) return
        expect(result.doc.references[0].reference_doctype).toBe('Sales Invoice')
    })

    it('fails when no party ledger entry exists', () => {
        const voucher = makePaymentVoucher({
            ledgerEntries: [makeLedgerEntry({ ledgerName: 'Bank Account', isPartyLedger: false, amount: 5000 })],
        })
        const result = transformPayment(voucher, config)

        expect(result.success).toBe(false)
        if (result.success) return
        expect(result.error.code).toBe('TRANSFORM_FAILED')
    })

    it('sets custom_tally_voucher_number from voucher', () => {
        const voucher = makePaymentVoucher({ voucherNumber: 'PMT-099' })
        const result = transformPayment(voucher, config)

        expect(result.success).toBe(true)
        if (!result.success) return
        expect(result.doc.custom_tally_voucher_number).toBe('PMT-099')
    })
})
