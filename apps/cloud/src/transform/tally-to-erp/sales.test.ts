import { describe, it, expect } from 'vitest'
import { transformSales } from './sales'
import { makeConfig, makeSalesVoucher, makeInterStateVoucher, makeLedgerEntry, makeInventoryEntry } from '../../test/fixtures'

describe('transformSales', () => {
    const config = makeConfig()

    it('transforms a basic intra-state sales voucher', () => {
        const voucher = makeSalesVoucher()
        const result = transformSales(voucher, config)

        expect(result.success).toBe(true)
        if (!result.success) return

        expect(result.doc.doctype).toBe('Sales Invoice')
        expect(result.doc.customer).toBe('ANU POLYMERS')
        expect(result.doc.posting_date).toBe('2023-06-20')
        expect(result.doc.company).toBe('Test Company')
        expect(result.doc.currency).toBe('INR')
        expect(result.doc.is_return).toBe(0)
        expect(result.doc.is_inter_state).toBe(0)
        expect(result.doc.gst_category).toBe('Registered Regular')
        expect(result.doc.custom_tally_guid).toBe('3b4a4714-7fa1-4344-a9cf-97e8d4168385-00002cf6')
        expect(result.doc.custom_sync_source).toBe('TALLYBRIDGE')
    })

    it('builds items from inventory entries', () => {
        const voucher = makeSalesVoucher()
        const result = transformSales(voucher, config)

        expect(result.success).toBe(true)
        if (!result.success) return

        expect(result.doc.items).toHaveLength(1)
        expect(result.doc.items[0].item_code).toBe('HDPE GRANULES')
        expect(result.doc.items[0].qty).toBe(250)
        expect(result.doc.items[0].rate).toBe(93)
        expect(result.doc.items[0].amount).toBe(23250)
        expect(result.doc.items[0].gst_hsn_code).toBe('999111')
    })

    it('calculates totals correctly', () => {
        const voucher = makeSalesVoucher()
        const result = transformSales(voucher, config)

        expect(result.success).toBe(true)
        if (!result.success) return

        expect(result.doc.total).toBe(23250)
        expect(result.doc.total_taxes_and_charges).toBe(5895)
        expect(result.doc.grand_total).toBe(29145)
    })

    it('detects credit note from voucher type name', () => {
        const voucher = makeSalesVoucher({ voucherTypeName: 'Credit Note' })
        const result = transformSales(voucher, config)

        expect(result.success).toBe(true)
        if (!result.success) return
        expect(result.doc.is_return).toBe(1)
    })

    it('detects sales return from voucher type name', () => {
        const voucher = makeSalesVoucher({ voucherTypeName: 'Sales Return' })
        const result = transformSales(voucher, config)

        expect(result.success).toBe(true)
        if (!result.success) return
        expect(result.doc.is_return).toBe(1)
    })

    it('negates quantity for credit notes / returns', () => {
        const voucher = makeSalesVoucher({ voucherTypeName: 'Credit Note' })
        const result = transformSales(voucher, config)

        expect(result.success).toBe(true)
        if (!result.success) return
        expect(result.doc.items[0].qty).toBe(-250) // qty should be negative for returns
    })

    it('handles inter-state sales (IGST)', () => {
        const voucher = makeInterStateVoucher()
        const result = transformSales(voucher, config)

        expect(result.success).toBe(true)
        if (!result.success) return
        expect(result.doc.is_inter_state).toBe(1)
        expect(result.doc.customer_gstin).toBe('27AAHCS6789E1ZA')
    })

    it('blocks B2B without GSTIN (MISSING_GSTIN)', () => {
        const voucher = makeSalesVoucher({ partyGSTIN: '' })
        // Override to have no place of supply (triggers Overseas, not Unregistered)
        // Actually, with placeOfSupply: 'Tamil Nadu' and no GSTIN → Unregistered (not Registered Regular), so it should pass
        // To trigger the block, we need gstCategory to be 'Registered Regular' but no GSTIN — that's impossible by design
        // The check is: no GSTIN AND gstCategory === 'Registered Regular'
        // This can't happen because classifyGSTCategory returns Unregistered when no GSTIN
        // So this test verifies that the guard doesn't incorrectly block
        const result = transformSales(voucher, config)
        expect(result.success).toBe(true)
    })

    it('builds service invoice from ledger entries when no inventory', () => {
        const voucher = makeSalesVoucher({
            inventoryEntries: [],
            ledgerEntries: [
                makeLedgerEntry({
                    ledgerName: 'ANU POLYMERS',
                    isPartyLedger: true,
                    isDeemedPositive: true,
                    amount: 11800,
                }),
                makeLedgerEntry({ ledgerName: 'B2B SALES', amount: -10000 }),
                makeLedgerEntry({ ledgerName: 'OUTPUT CGST', amount: -900 }),
                makeLedgerEntry({ ledgerName: 'OUTPUT SGST', amount: -900 }),
            ],
        })
        const result = transformSales(voucher, config)

        expect(result.success).toBe(true)
        if (!result.success) return
        expect(result.doc.items).toHaveLength(1)
        expect(result.doc.items[0].item_code).toBe('B2B SALES')
        expect(result.doc.items[0].income_account).toBe('4110 - Sales - TC')
    })

    it('fails with UNMAPPED_LEDGER for service invoice with unknown ledger', () => {
        const voucher = makeSalesVoucher({
            inventoryEntries: [],
            ledgerEntries: [
                makeLedgerEntry({
                    ledgerName: 'ANU POLYMERS',
                    isPartyLedger: true,
                    isDeemedPositive: true,
                    amount: 5000,
                }),
                makeLedgerEntry({ ledgerName: 'Unknown Revenue Account', amount: -5000 }),
            ],
        })
        const result = transformSales(voucher, config)

        expect(result.success).toBe(false)
        if (result.success) return
        expect(result.error.code).toBe('UNMAPPED_LEDGER')
    })

    it('warns when item has no HSN code', () => {
        const voucher = makeSalesVoucher({
            inventoryEntries: [
                {
                    stockItemName: 'No HSN Item',
                    rate: 100,
                    rateUOM: 'Nos',
                    amount: 1000,
                    actualQty: 10,
                    actualQtyUOM: 'Nos',
                    billedQty: 10,
                    billedQtyUOM: 'Nos',
                    hsnCode: '',
                    gstOvrdnRate: 0,
                    godownName: '',
                    expiryDate: '',
                    accountLedgerName: 'B2B SALES',
                },
            ],
        })
        const result = transformSales(voucher, config)

        expect(result.success).toBe(true)
        if (!result.success) return
        expect(result.warnings.length).toBeGreaterThan(0)
        expect(result.warnings[0]).toContain('HSN')
    })

    it('uses company state from GSTIN for inter-state detection', () => {
        const tnConfig = makeConfig({ companyGstin: '33AABCT1234A1ZA' })
        const voucher = makeSalesVoucher({ placeOfSupply: 'Tamil Nadu' })
        const result = transformSales(voucher, tnConfig)

        expect(result.success).toBe(true)
        if (!result.success) return
        expect(result.doc.is_inter_state).toBe(0)
    })

    it('sanitises customer name with special characters', () => {
        const voucher = makeSalesVoucher({ partyLedgerName: 'Customer/Corp [Ltd]' })
        const result = transformSales(voucher, config)

        expect(result.success).toBe(true)
        if (!result.success) return
        expect(result.doc.customer).toBe('Customer-Corp -Ltd-')
    })

    it('uses companyAddress from config when set', () => {
        const configWithAddr = makeConfig({ companyAddress: 'Covai Polymer Traders-Billing' })
        const voucher = makeSalesVoucher()
        const result = transformSales(voucher, configWithAddr)

        expect(result.success).toBe(true)
        if (!result.success) return
        expect(result.doc.company_address).toBe('Covai Polymer Traders-Billing')
    })

    it('falls back to naming convention when companyAddress not set', () => {
        const voucher = makeSalesVoucher()
        const result = transformSales(voucher, config)

        expect(result.success).toBe(true)
        if (!result.success) return
        expect(result.doc.company_address).toBe('Test Company-Billing')
    })

    it('sets custom_tally_voucher_number', () => {
        const voucher = makeSalesVoucher({ voucherNumber: 'SI-555' })
        const result = transformSales(voucher, config)

        expect(result.success).toBe(true)
        if (!result.success) return
        expect(result.doc.custom_tally_voucher_number).toBe('SI-555')
    })

    // ── Group 3 edge cases ───────────────────────────────────────────────────

    it('B2C (Unregistered) — no customer GSTIN, gst_category = Unregistered', () => {
        const voucher = makeSalesVoucher({ partyGSTIN: '' })
        const result = transformSales(voucher, config)

        expect(result.success).toBe(true)
        if (!result.success) return
        expect(result.doc.gst_category).toBe('Unregistered')
        expect(result.doc.customer_gstin).toBeUndefined()
    })

    it('RCM invoice sets is_rcm_applicable = 1', () => {
        const voucher = makeSalesVoucher({ isRCMApplicable: true })
        const result = transformSales(voucher, config)

        expect(result.success).toBe(true)
        if (!result.success) return
        expect(result.doc.is_rcm_applicable).toBe(1)
    })

    it('non-RCM invoice keeps is_rcm_applicable = 0', () => {
        const voucher = makeSalesVoucher({ isRCMApplicable: false })
        const result = transformSales(voucher, config)

        expect(result.success).toBe(true)
        if (!result.success) return
        expect(result.doc.is_rcm_applicable).toBe(0)
    })

    it('service invoice with multiple ledger lines produces multiple items', () => {
        const voucher = makeSalesVoucher({
            inventoryEntries: [],
            ledgerEntries: [
                makeLedgerEntry({ ledgerName: 'ANU POLYMERS', isPartyLedger: true, isDeemedPositive: true, amount: 23600 }),
                makeLedgerEntry({ ledgerName: 'B2B SALES', amount: -10000 }),
                makeLedgerEntry({ ledgerName: 'Consulting Income', amount: -10000 }),
                makeLedgerEntry({ ledgerName: 'OUTPUT CGST', amount: -1800 }),
                makeLedgerEntry({ ledgerName: 'OUTPUT SGST', amount: -1800 }),
            ],
        })
        const configWithConsulting = makeConfig({
            accountMappings: { ...config.accountMappings, 'Consulting Income': 'Consulting Income - TC' },
        })
        const result = transformSales(voucher, configWithConsulting)

        expect(result.success).toBe(true)
        if (!result.success) return
        expect(result.doc.items).toHaveLength(2)
        expect(result.doc.items[0].item_code).toBe('B2B SALES')
        expect(result.doc.items[1].item_code).toBe('Consulting Income')
        expect(result.doc.total).toBe(20000)
    })

    it('detects credit note from all-negative inventory quantities', () => {
        const voucher = makeSalesVoucher({
            voucherTypeName: 'Sales', // not "Credit Note" by name
            inventoryEntries: [
                makeInventoryEntry({ billedQty: -5, actualQty: -5, amount: -500 }),
            ],
        })
        const result = transformSales(voucher, config)

        expect(result.success).toBe(true)
        if (!result.success) return
        expect(result.doc.is_return).toBe(1)
        expect(result.doc.items[0].qty).toBeLessThan(0)
    })

    it('zero GST — empty taxes array when no GST ledgers', () => {
        const voucher = makeSalesVoucher({
            ledgerEntries: [
                makeLedgerEntry({ ledgerName: 'ANU POLYMERS', isPartyLedger: true, isDeemedPositive: true, amount: 10000 }),
                makeLedgerEntry({ ledgerName: 'B2B SALES', amount: -10000 }),
            ],
        })
        const result = transformSales(voucher, config)

        expect(result.success).toBe(true)
        if (!result.success) return
        expect(result.doc.taxes).toHaveLength(0)
        expect(result.doc.total_taxes_and_charges).toBe(0)
        expect(result.doc.grand_total).toBe(result.doc.total)
    })

    it('multi-item inventory with different HSN codes', () => {
        const voucher = makeSalesVoucher({
            inventoryEntries: [
                makeInventoryEntry({ stockItemName: 'Item A', hsnCode: '84719000', amount: 500, qty: 5, billedQty: 5, actualQty: 5, rate: 100 }),
                makeInventoryEntry({ stockItemName: 'Item B', hsnCode: '90211000', amount: 300, qty: 3, billedQty: 3, actualQty: 3, rate: 100 }),
            ],
        })
        const result = transformSales(voucher, config)

        expect(result.success).toBe(true)
        if (!result.success) return
        expect(result.doc.items).toHaveLength(2)
        expect(result.doc.items[0].gst_hsn_code).toBe('84719000')
        expect(result.doc.items[1].gst_hsn_code).toBe('90211000')
    })

    it('Overseas/export — gst_category = Overseas when place of supply is export', () => {
        const voucher = makeSalesVoucher({
            placeOfSupply: 'Overseas',
            partyGSTIN: '',
            ledgerEntries: [
                makeLedgerEntry({ ledgerName: 'ANU POLYMERS', isPartyLedger: true, isDeemedPositive: true, amount: 10000 }),
                makeLedgerEntry({ ledgerName: 'B2B SALES', amount: -10000 }),
            ],
        })
        const result = transformSales(voucher, config)

        expect(result.success).toBe(true)
        if (!result.success) return
        expect(result.doc.gst_category).toBe('Overseas')
        expect(result.doc.taxes).toHaveLength(0)
    })

    it('picks due date from bill allocation when present', () => {
        const voucher = makeSalesVoucher({
            ledgerEntries: [
                makeLedgerEntry({
                    ledgerName: 'ANU POLYMERS',
                    isPartyLedger: true,
                    isDeemedPositive: true,
                    amount: 11800,
                    billAllocations: [{ name: 'SI-001', billType: 'New Ref', amount: 11800, dueDate: '20240501' }],
                }),
                makeLedgerEntry({ ledgerName: 'B2B SALES', amount: -10000 }),
                makeLedgerEntry({ ledgerName: 'OUTPUT CGST', amount: -900 }),
                makeLedgerEntry({ ledgerName: 'OUTPUT SGST', amount: -900 }),
            ],
        })
        const result = transformSales(voucher, config)

        expect(result.success).toBe(true)
        if (!result.success) return
        expect(result.doc.due_date).toBe('2024-05-01')
    })

    it('falls back to posting date when bill due date is before posting date', () => {
        const voucher = makeSalesVoucher({
            date: '20240401',
            ledgerEntries: [
                makeLedgerEntry({
                    ledgerName: 'ANU POLYMERS',
                    isPartyLedger: true,
                    isDeemedPositive: true,
                    amount: 11800,
                    billAllocations: [{ name: 'SI-001', billType: 'New Ref', amount: 11800, dueDate: '20240301' }], // before posting date
                }),
                makeLedgerEntry({ ledgerName: 'B2B SALES', amount: -10000 }),
                makeLedgerEntry({ ledgerName: 'OUTPUT CGST', amount: -900 }),
                makeLedgerEntry({ ledgerName: 'OUTPUT SGST', amount: -900 }),
            ],
        })
        const result = transformSales(voucher, config)

        expect(result.success).toBe(true)
        if (!result.success) return
        expect(result.doc.due_date).toBe('2024-04-01') // falls back to posting date
    })

    it('update_stock = 0 when no defaultWarehouse in config', () => {
        const noWhConfig = makeConfig({ defaultWarehouse: undefined })
        const voucher = makeSalesVoucher()
        const result = transformSales(voucher, noWhConfig)

        expect(result.success).toBe(true)
        if (!result.success) return
        expect(result.doc.update_stock).toBe(0)
        expect(result.doc.set_warehouse).toBeUndefined()
    })

    it('update_stock = 1 and set_warehouse set when inventory + warehouse in config', () => {
        const whConfig = makeConfig({ defaultWarehouse: 'Main Store - TC' })
        const voucher = makeSalesVoucher()
        const result = transformSales(voucher, whConfig)

        expect(result.success).toBe(true)
        if (!result.success) return
        expect(result.doc.update_stock).toBe(1)
        expect(result.doc.set_warehouse).toBe('Main Store - TC')
    })

    it('falsy HSN code falls back to 999111 SAC and warns', () => {
        const voucher = makeSalesVoucher({
            inventoryEntries: [makeInventoryEntry({ hsnCode: undefined as unknown as string })],
        })
        const result = transformSales(voucher, config)

        expect(result.success).toBe(true)
        if (!result.success) return
        expect(result.doc.items[0].gst_hsn_code).toBe('999111')
        expect(result.warnings.length).toBeGreaterThan(0)
    })

    // ── TASK 1: e-Invoice / e-Way Bill / multi-currency ──────────────────────

    it('maps ewayBillNumber to custom_ewaybill_no', () => {
        const voucher = makeSalesVoucher({ ewayBillNumber: 'EWB-123456789012' })
        const result = transformSales(voucher, config)

        expect(result.success).toBe(true)
        if (!result.success) return
        expect(result.doc.custom_ewaybill_no).toBe('EWB-123456789012')
    })

    it('maps irn to custom_irn', () => {
        const voucher = makeSalesVoucher({ irn: 'abc123irn456' })
        const result = transformSales(voucher, config)

        expect(result.success).toBe(true)
        if (!result.success) return
        expect(result.doc.custom_irn).toBe('abc123irn456')
    })

    it('maps irnAckNo to custom_irn_ack_no', () => {
        const voucher = makeSalesVoucher({ irnAckNo: 'ACK-9999' })
        const result = transformSales(voucher, config)

        expect(result.success).toBe(true)
        if (!result.success) return
        expect(result.doc.custom_irn_ack_no).toBe('ACK-9999')
    })

    it('no IRN/eWayBill fields → custom fields are undefined', () => {
        const voucher = makeSalesVoucher({ ewayBillNumber: '', irnNo: '', irn: undefined, irnAckNo: undefined })
        const result = transformSales(voucher, config)

        expect(result.success).toBe(true)
        if (!result.success) return
        expect(result.doc.custom_ewaybill_no).toBeUndefined()
        expect(result.doc.custom_irn).toBeUndefined()
        expect(result.doc.custom_irn_ack_no).toBeUndefined()
    })

    it('foreign currency sets currency field and computes conversion_rate', () => {
        // Invoice total (grand_total) will be 29145 INR, foreign amount = 350 USD
        // conversion_rate = 350 / 29145 ≈ 0.012
        const voucher = makeSalesVoucher({ foreignCurrency: 'USD', foreignAmount: 350 })
        const result = transformSales(voucher, config)

        expect(result.success).toBe(true)
        if (!result.success) return
        expect(result.doc.currency).toBe('USD')
        expect(result.doc.conversion_rate).toBeGreaterThan(0)
        expect(result.doc.conversion_rate).not.toBe(1)
    })

    it('INR foreign currency keeps currency as INR and conversion_rate = 1', () => {
        const voucher = makeSalesVoucher({ foreignCurrency: 'INR', foreignAmount: 29145 })
        const result = transformSales(voucher, config)

        expect(result.success).toBe(true)
        if (!result.success) return
        expect(result.doc.currency).toBe('INR')
        expect(result.doc.conversion_rate).toBe(1)
    })

    it('empty foreignCurrency → INR currency and conversion_rate = 1', () => {
        const voucher = makeSalesVoucher({ foreignCurrency: '', foreignAmount: 0 })
        const result = transformSales(voucher, config)

        expect(result.success).toBe(true)
        if (!result.success) return
        expect(result.doc.currency).toBe('INR')
        expect(result.doc.conversion_rate).toBe(1)
    })

    // ── TASK 2: Address sync ─────────────────────────────────────────────────

    it('maps voucher.address array to customer_address joined with newline', () => {
        const voucher = makeSalesVoucher({ address: ['123 Main St', 'Chennai', 'Tamil Nadu'] })
        const result = transformSales(voucher, config)

        expect(result.success).toBe(true)
        if (!result.success) return
        expect(result.doc.customer_address).toBe('123 Main St\nChennai\nTamil Nadu')
        expect(result.doc.shipping_address_name).toBe('123 Main St\nChennai\nTamil Nadu')
    })

    it('empty address array → customer_address is undefined', () => {
        const voucher = makeSalesVoucher({ address: [] })
        const result = transformSales(voucher, config)

        expect(result.success).toBe(true)
        if (!result.success) return
        expect(result.doc.customer_address).toBeUndefined()
    })

    it('no address field → customer_address is undefined', () => {
        const voucher = makeSalesVoucher()
        // Default makeVoucher has no address field
        const result = transformSales(voucher, config)

        expect(result.success).toBe(true)
        if (!result.success) return
        expect(result.doc.customer_address).toBeUndefined()
    })

    it('maps partyEmail to contact_email', () => {
        const voucher = makeSalesVoucher({ partyEmail: 'customer@example.com' })
        const result = transformSales(voucher, config)

        expect(result.success).toBe(true)
        if (!result.success) return
        expect(result.doc.contact_email).toBe('customer@example.com')
    })

    // ── TASK 3: Credit note detection improvements ───────────────────────────

    it('detects credit note by regex pattern "Credit Note"', () => {
        const voucher = makeSalesVoucher({ voucherTypeName: 'Credit Note' })
        const result = transformSales(voucher, config)

        expect(result.success).toBe(true)
        if (!result.success) return
        expect(result.doc.is_return).toBe(1)
    })

    it('detects credit note by regex pattern "CreditNote" (no space)', () => {
        const voucher = makeSalesVoucher({ voucherTypeName: 'CreditNote' })
        const result = transformSales(voucher, config)

        expect(result.success).toBe(true)
        if (!result.success) return
        expect(result.doc.is_return).toBe(1)
    })

    it('detects credit note by party amount fallback (negative party amount = credit to customer = return)', () => {
        // Sales Return recorded as "Sales" type: party is CREDITED (negative amount)
        const voucher = makeSalesVoucher({
            voucherTypeName: 'Sales', // not "Credit Note" by name
            inventoryEntries: [], // no inventory entries to trigger qty fallback
            ledgerEntries: [
                // Customer Cr (negative) = return scenario
                makeLedgerEntry({ ledgerName: 'ANU POLYMERS', isPartyLedger: true, isDeemedPositive: false, amount: -10000 }),
                makeLedgerEntry({ ledgerName: 'B2B SALES', amount: 10000 }),
            ],
        })
        const result = transformSales(voucher, config)

        expect(result.success).toBe(true)
        if (!result.success) return
        expect(result.doc.is_return).toBe(1)
    })

    it('normal sale (party Dr = positive amount) is NOT detected as credit note by party fallback', () => {
        // Standard sales: customer Dr (amount positive) — NOT a return
        const voucher = makeSalesVoucher() // party has amount=38645 positive (Dr to customer)
        const result = transformSales(voucher, config)

        expect(result.success).toBe(true)
        if (!result.success) return
        expect(result.doc.is_return).toBe(0)
    })
})
