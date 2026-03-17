import { describe, it, expect } from 'vitest'
import { transformPurchase } from './purchase'
import { makeConfig, makePurchaseVoucher, makeLedgerEntry, makeInventoryEntry } from '../../test/fixtures'

describe('transformPurchase', () => {
    const config = makeConfig()

    it('transforms a basic intra-state purchase voucher', () => {
        const voucher = makePurchaseVoucher()
        const result = transformPurchase(voucher, config)

        expect(result.success).toBe(true)
        if (!result.success) return

        expect(result.doc.doctype).toBe('Purchase Invoice')
        expect(result.doc.supplier).toBe('SERVO PACKAGING LIMITED')
        expect(result.doc.posting_date).toBe('2023-05-09')
        expect(result.doc.is_return).toBe(0)
        expect(result.doc.is_inter_state).toBe(0)
        expect(result.doc.gst_category).toBe('Registered Regular')
        expect(result.doc.custom_tally_guid).toBe('3b4a4714-7fa1-4344-a9cf-97e8d4168385-00002b69')
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
        expect(result.doc.bill_no).toBe('26')
    })

    it('builds items from inventory entries', () => {
        const voucher = makePurchaseVoucher()
        const result = transformPurchase(voucher, config)

        expect(result.success).toBe(true)
        if (!result.success) return

        expect(result.doc.items).toHaveLength(1)
        expect(result.doc.items[0].item_code).toBe('FILLER')
        expect(result.doc.items[0].expense_account).toBe('1410 - Stock In Hand - TC')
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
                makeLedgerEntry({ ledgerName: 'B2B PURCHASE', isDeemedPositive: true, amount: 10000 }),
            ],
        })
        const result = transformPurchase(voucher, config)

        expect(result.success).toBe(true)
        if (!result.success) return
        expect(result.doc.items).toHaveLength(1)
        expect(result.doc.items[0].item_code).toBe('B2B PURCHASE')
    })

    it('calculates totals correctly', () => {
        const voucher = makePurchaseVoucher()
        const result = transformPurchase(voucher, config)

        expect(result.success).toBe(true)
        if (!result.success) return

        expect(result.doc.total).toBe(310000)
        expect(result.doc.total_taxes_and_charges).toBe(0)
        expect(result.doc.grand_total).toBe(310000)
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

    // ── Group 4 edge cases ───────────────────────────────────────────────────

    it('Composition scheme supplier — clears tax lines', () => {
        // GSTIN index-1 char '4' = Composition scheme (state code 34 = Puducherry)
        const voucher = makePurchaseVoucher({ partyGSTIN: '34AABCS5678E1ZB' })
        const result = transformPurchase(voucher, config)

        expect(result.success).toBe(true)
        if (!result.success) return
        expect(result.doc.gst_category).toBe('Registered Composition')
        expect(result.doc.taxes).toHaveLength(0)
    })

    it('Unregistered supplier — clears tax lines', () => {
        const voucher = makePurchaseVoucher({ partyGSTIN: '' })
        const result = transformPurchase(voucher, config)

        expect(result.success).toBe(true)
        if (!result.success) return
        expect(result.doc.gst_category).toBe('Unregistered')
        expect(result.doc.taxes).toHaveLength(0)
    })

    it('RCM purchase sets is_rcm_applicable = 1', () => {
        const voucher = makePurchaseVoucher({ isRCMApplicable: true })
        const result = transformPurchase(voucher, config)

        expect(result.success).toBe(true)
        if (!result.success) return
        expect(result.doc.is_rcm_applicable).toBe(1)
    })

    it('detects debit note from all-negative inventory quantities', () => {
        const voucher = makePurchaseVoucher({
            voucherTypeName: 'Purchase', // not "Debit Note" by name
            inventoryEntries: [
                makeInventoryEntry({ billedQty: -3, actualQty: -3, amount: -300, accountLedgerName: 'B2B PURCHASE' }),
            ],
        })
        const result = transformPurchase(voucher, config)

        expect(result.success).toBe(true)
        if (!result.success) return
        expect(result.doc.is_return).toBe(1)
        expect(result.doc.items[0].qty).toBeLessThan(0)
    })

    it('inter-state purchase sets is_inter_state = 1', () => {
        const voucher = makePurchaseVoucher({
            placeOfSupply: 'Maharashtra',
            partyGSTIN: '27AABCS5678E1ZB',
            ledgerEntries: [
                makeLedgerEntry({ ledgerName: 'Supplier XYZ', isPartyLedger: true, isDeemedPositive: false, amount: -11800 }),
                makeLedgerEntry({ ledgerName: 'B2B PURCHASE', isDeemedPositive: true, amount: 10000 }),
                makeLedgerEntry({ ledgerName: 'Input IGST 18%', isDeemedPositive: true, amount: 1800 }),
            ],
        })
        const result = transformPurchase(voucher, config)

        expect(result.success).toBe(true)
        if (!result.success) return
        expect(result.doc.is_inter_state).toBe(1)
        expect(result.doc.supplier_gstin).toBe('27AABCS5678E1ZB')
    })

    it('service purchase with multiple ledger items produces multiple items', () => {
        const voucher = makePurchaseVoucher({
            inventoryEntries: [],
            ledgerEntries: [
                makeLedgerEntry({ ledgerName: 'Supplier XYZ', isPartyLedger: true, isDeemedPositive: false, amount: -20000 }),
                makeLedgerEntry({ ledgerName: 'B2B PURCHASE', isDeemedPositive: true, amount: 10000 }),
                makeLedgerEntry({ ledgerName: 'Freight Charges', isDeemedPositive: true, amount: 10000 }),
            ],
        })
        const configWithFreight = makeConfig({
            accountMappings: { ...config.accountMappings, 'Freight Charges': 'Freight Charges - TC' },
        })
        const result = transformPurchase(voucher, configWithFreight)

        expect(result.success).toBe(true)
        if (!result.success) return
        expect(result.doc.items).toHaveLength(2)
        expect(result.doc.total).toBe(20000)
    })

    it('bill_date derived from referenceDate when provided', () => {
        const voucher = makePurchaseVoucher({ referenceDate: '20240315', referenceNumber: 'SUP-123' })
        const result = transformPurchase(voucher, config)

        expect(result.success).toBe(true)
        if (!result.success) return
        expect(result.doc.bill_date).toBe('2024-03-15')
        expect(result.doc.bill_no).toBe('SUP-123')
    })

    it('no HSN code warning for purchase item', () => {
        const voucher = makePurchaseVoucher({
            inventoryEntries: [makeInventoryEntry({ hsnCode: '', accountLedgerName: 'B2B PURCHASE' })],
        })
        const result = transformPurchase(voucher, config)

        expect(result.success).toBe(true)
        if (!result.success) return
        expect(result.doc.items[0].gst_hsn_code).toBe('999111')
        expect(result.warnings.length).toBeGreaterThan(0)
    })
})
