import { describe, it, expect } from 'vitest'
import { transformPayment } from './payment'
import { makeConfig, makePaymentVoucher, makeReceiptVoucher, makeLedgerEntry } from '../../test/fixtures'

describe('transformPayment', () => {
    const config = makeConfig({
        accountMappings: {
            ...makeConfig().accountMappings,
            'OFFICE RENT': '5209 - Office Rent - TC',
        },
    })

    it('transforms a supplier payment voucher', () => {
        const voucher = makePaymentVoucher()
        const result = transformPayment(voucher, config)

        expect(result.success).toBe(true)
        if (!result.success) return

        expect(result.doc.doctype).toBe('Payment Entry')
        expect(result.doc.payment_type).toBe('Pay')
        expect(result.doc.party_type).toBe('Supplier')
        expect(result.doc.party).toBe('SERVO PACKAGING LIMITED')
        expect(result.doc.paid_amount).toBe(33000)
        expect(result.doc.received_amount).toBe(33000)
        expect(result.doc.custom_tally_guid).toBe('3b4a4714-7fa1-4344-a9cf-97e8d4168385-0000338b')
    })

    it('transforms a customer receipt voucher', () => {
        const voucher = makeReceiptVoucher()
        const result = transformPayment(voucher, config)

        expect(result.success).toBe(true)
        if (!result.success) return

        expect(result.doc.payment_type).toBe('Receive')
        expect(result.doc.party_type).toBe('Customer')
        expect(result.doc.party).toBe('ANU POLYMERS')
    })

    it('sets paid_from/paid_to based on receipt vs payment', () => {
        const receipt = makeReceiptVoucher()
        const rResult = transformPayment(receipt, config)
        expect(rResult.success).toBe(true)
        if (!rResult.success) return
        // Receipt: paid_from = Debtors, paid_to = bank
        expect(rResult.doc.paid_from).toContain('Debtors')
        expect(rResult.doc.paid_to).toBe('1220 - HDFC Bank - TC')

        const payment = makePaymentVoucher()
        const pResult = transformPayment(payment, config)
        expect(pResult.success).toBe(true)
        if (!pResult.success) return
        // Payment: paid_from = bank (HDFC BANK), paid_to = Creditors
        expect(pResult.doc.paid_from).toBe('1220 - HDFC Bank - TC')
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
                makeLedgerEntry({ ledgerName: 'HDFC BANK', isDeemedPositive: false, amount: -11800 }),
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
                makeLedgerEntry({ ledgerName: 'HDFC BANK', isDeemedPositive: false, amount: -5000 }),
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
                makeLedgerEntry({ ledgerName: 'HDFC BANK', isDeemedPositive: false, amount: -11800 }),
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
                makeLedgerEntry({ ledgerName: 'HDFC BANK', isDeemedPositive: true, amount: 11800 }),
            ],
        })
        const result = transformPayment(voucher, config)

        expect(result.success).toBe(true)
        if (!result.success) return
        expect(result.doc.references[0].reference_doctype).toBe('Sales Invoice')
    })

    it('fails when no party ledger entry exists', () => {
        const voucher = makePaymentVoucher({
            partyLedgerName: 'NON EXISTENT PARTY',
            ledgerEntries: [makeLedgerEntry({ ledgerName: 'HDFC BANK', isPartyLedger: false, amount: 5000 })],
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

    // ── Group 5 edge cases ───────────────────────────────────────────────────

    it('FALLBACK_TO_JOURNAL when party ledger is a bank account', () => {
        const bankConfig = makeConfig({ bankLedgers: ['HDFC BANK'] })
        const voucher = makePaymentVoucher({
            ledgerEntries: [
                makeLedgerEntry({ ledgerName: 'HDFC BANK', isPartyLedger: true, isDeemedPositive: true, amount: 10000 }),
                makeLedgerEntry({ ledgerName: 'Cash', isDeemedPositive: false, amount: -10000 }),
            ],
        })
        const result = transformPayment(voucher, bankConfig)

        expect(result.success).toBe(false)
        if (result.success) return
        expect(result.error.code).toBe('FALLBACK_TO_JOURNAL')
    })

    it('New Ref bill allocations are not added to references (only Agst Ref)', () => {
        const voucher = makePaymentVoucher({
            ledgerEntries: [
                makeLedgerEntry({
                    ledgerName: 'Supplier XYZ',
                    isPartyLedger: true,
                    isDeemedPositive: true,
                    amount: 11800,
                    billAllocations: [{ name: 'PI-002', billType: 'New Ref', amount: 11800, dueDate: '' }],
                }),
                makeLedgerEntry({ ledgerName: 'HDFC BANK', isDeemedPositive: false, amount: -11800 }),
            ],
        })
        const result = transformPayment(voucher, config)

        expect(result.success).toBe(true)
        if (!result.success) return
        expect(result.doc.references).toHaveLength(0)
    })

    it('multiple Agst Ref allocations map to multiple references', () => {
        const voucher = makePaymentVoucher({
            ledgerEntries: [
                makeLedgerEntry({
                    ledgerName: 'Supplier XYZ',
                    isPartyLedger: true,
                    isDeemedPositive: true,
                    amount: 23600,
                    billAllocations: [
                        { name: 'PI-010', billType: 'Agst Ref', amount: 11800, dueDate: '' },
                        { name: 'PI-011', billType: 'Agst Ref', amount: 11800, dueDate: '' },
                    ],
                }),
                makeLedgerEntry({ ledgerName: 'HDFC BANK', isDeemedPositive: false, amount: -23600 }),
            ],
        })
        const result = transformPayment(voucher, config)

        expect(result.success).toBe(true)
        if (!result.success) return
        expect(result.doc.references).toHaveLength(2)
        expect(result.doc.references[0].reference_name).toBe('PI-010')
        expect(result.doc.references[1].reference_name).toBe('PI-011')
    })

    it('falls back to GUID-based reference_no when no bank allocation or voucher number', () => {
        const voucher = makePaymentVoucher({
            guid: 'ABCDEF123456789012345678',
            voucherNumber: '',
            ledgerEntries: [
                makeLedgerEntry({ ledgerName: 'Supplier XYZ', isPartyLedger: true, isDeemedPositive: true, amount: 5000 }),
                makeLedgerEntry({ ledgerName: 'HDFC BANK', isDeemedPositive: false, amount: -5000 }),
            ],
        })
        const result = transformPayment(voucher, config)

        expect(result.success).toBe(true)
        if (!result.success) return
        expect(result.doc.reference_no).toMatch(/^TLY-/)
    })

    it('amount is absolute value regardless of ledger sign', () => {
        // Party entry has negative amount (as in a receipt)
        const voucher = makeReceiptVoucher({
            ledgerEntries: [
                makeLedgerEntry({ ledgerName: 'Customer ABC', isPartyLedger: true, isDeemedPositive: false, amount: -15000 }),
                makeLedgerEntry({ ledgerName: 'HDFC BANK', isDeemedPositive: true, amount: 15000 }),
            ],
        })
        const result = transformPayment(voucher, config)

        expect(result.success).toBe(true)
        if (!result.success) return
        expect(result.doc.paid_amount).toBe(15000)
        expect(result.doc.received_amount).toBe(15000)
    })

    it('cash payment uses Cash account as paid_from', () => {
        const voucher = makePaymentVoucher({
            ledgerEntries: [
                makeLedgerEntry({ ledgerName: 'Supplier XYZ', isPartyLedger: true, isDeemedPositive: true, amount: 3000 }),
                makeLedgerEntry({ ledgerName: 'Cash', isDeemedPositive: false, amount: -3000 }),
            ],
        })
        const result = transformPayment(voucher, config)

        expect(result.success).toBe(true)
        if (!result.success) return
        expect(result.doc.paid_from).toBe('1211 - Cash - TC')
    })

    // ── TASK 4: Advance payment tracking ────────────────────────────────────

    it('Advance bill type → advance_payment_entries populated', () => {
        const voucher = makePaymentVoucher({
            ledgerEntries: [
                makeLedgerEntry({
                    ledgerName: 'Supplier XYZ',
                    isPartyLedger: true,
                    isDeemedPositive: true,
                    amount: 50000,
                    billAllocations: [{ name: 'ADV-001', billType: 'Advance', amount: 50000, dueDate: '' }],
                }),
                makeLedgerEntry({ ledgerName: 'HDFC BANK', isDeemedPositive: false, amount: -50000 }),
            ],
        })
        const result = transformPayment(voucher, config)

        expect(result.success).toBe(true)
        if (!result.success) return
        expect(result.doc.advance_payment_entries).toHaveLength(1)
        expect(result.doc.advance_payment_entries![0].reference_name).toBe('ADV-001')
        expect(result.doc.advance_payment_entries![0].advance_amount).toBe(50000)
    })

    it('Advance bill type payment_type remains Pay', () => {
        const voucher = makePaymentVoucher({
            ledgerEntries: [
                makeLedgerEntry({
                    ledgerName: 'Supplier XYZ',
                    isPartyLedger: true,
                    isDeemedPositive: true,
                    amount: 25000,
                    billAllocations: [{ name: 'ADV-002', billType: 'Advance', amount: 25000, dueDate: '' }],
                }),
                makeLedgerEntry({ ledgerName: 'HDFC BANK', isDeemedPositive: false, amount: -25000 }),
            ],
        })
        const result = transformPayment(voucher, config)

        expect(result.success).toBe(true)
        if (!result.success) return
        expect(result.doc.payment_type).toBe('Pay')
    })

    it('On Account (New Ref) payment → references is empty (unallocated)', () => {
        const voucher = makePaymentVoucher({
            ledgerEntries: [
                makeLedgerEntry({
                    ledgerName: 'Supplier XYZ',
                    isPartyLedger: true,
                    isDeemedPositive: true,
                    amount: 10000,
                    billAllocations: [{ name: 'ON-ACCT-001', billType: 'New Ref', amount: 10000, dueDate: '' }],
                }),
                makeLedgerEntry({ ledgerName: 'HDFC BANK', isDeemedPositive: false, amount: -10000 }),
            ],
        })
        const result = transformPayment(voucher, config)

        expect(result.success).toBe(true)
        if (!result.success) return
        // On Account (New Ref only) → no Agst Ref references, empty array = unallocated
        expect(result.doc.references).toHaveLength(0)
        expect(result.doc.advance_payment_entries).toBeUndefined()
    })

    it('no advance entries when only Agst Ref allocations', () => {
        const voucher = makePaymentVoucher({
            ledgerEntries: [
                makeLedgerEntry({
                    ledgerName: 'Supplier XYZ',
                    isPartyLedger: true,
                    isDeemedPositive: true,
                    amount: 11800,
                    billAllocations: [{ name: 'PI-001', billType: 'Agst Ref', amount: 11800, dueDate: '' }],
                }),
                makeLedgerEntry({ ledgerName: 'HDFC BANK', isDeemedPositive: false, amount: -11800 }),
            ],
        })
        const result = transformPayment(voucher, config)

        expect(result.success).toBe(true)
        if (!result.success) return
        expect(result.doc.advance_payment_entries).toBeUndefined()
        expect(result.doc.references).toHaveLength(1)
    })

    it('advance_payment_entries use reference_type Purchase Invoice for payment', () => {
        const voucher = makePaymentVoucher({
            ledgerEntries: [
                makeLedgerEntry({
                    ledgerName: 'Supplier XYZ',
                    isPartyLedger: true,
                    isDeemedPositive: true,
                    amount: 15000,
                    billAllocations: [{ name: 'ADV-003', billType: 'Advance', amount: 15000, dueDate: '' }],
                }),
                makeLedgerEntry({ ledgerName: 'HDFC BANK', isDeemedPositive: false, amount: -15000 }),
            ],
        })
        const result = transformPayment(voucher, config)

        expect(result.success).toBe(true)
        if (!result.success) return
        expect(result.doc.advance_payment_entries![0].reference_type).toBe('Purchase Invoice')
    })

    it('advance_payment_entries use reference_type Sales Invoice for receipt', () => {
        const voucher = makeReceiptVoucher({
            ledgerEntries: [
                makeLedgerEntry({
                    ledgerName: 'Customer ABC',
                    isPartyLedger: true,
                    isDeemedPositive: false,
                    amount: -20000,
                    billAllocations: [{ name: 'ADV-CUST-001', billType: 'Advance', amount: -20000, dueDate: '' }],
                }),
                makeLedgerEntry({ ledgerName: 'HDFC BANK', isDeemedPositive: true, amount: 20000 }),
            ],
        })
        const result = transformPayment(voucher, config)

        expect(result.success).toBe(true)
        if (!result.success) return
        expect(result.doc.advance_payment_entries).toHaveLength(1)
        expect(result.doc.advance_payment_entries![0].reference_type).toBe('Sales Invoice')
    })
})
