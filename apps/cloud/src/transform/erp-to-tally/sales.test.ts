/**
 * Tests for ERPNext Sales Invoice → Tally Sales Voucher transform.
 */
import { describe, it, expect } from 'vitest'
import { erpSalesToTally } from './sales'
import { makeConfig, makeERPNextSalesInvoice } from '../../test/fixtures'

describe('erpSalesToTally', () => {
    const config = makeConfig()

    it('produces correct top-level structure', () => {
        const doc = makeERPNextSalesInvoice()
        const result = erpSalesToTally(doc, config)

        expect(result.voucherType).toBe('Sales')
        expect(result.isInvoice).toBe(true)
        expect(result.action).toBe('CREATE')
        expect(result.date).toBe('20230620')
        expect(result.partyLedgerName).toBe('ANU POLYMERS')
    })

    it('customer is Dr entry with isDeemedPositive=true and amount=grand_total', () => {
        const doc = makeERPNextSalesInvoice({ grand_total: 1180 })
        const result = erpSalesToTally(doc, config)

        const partyEntry = result.ledgerEntries[0]
        expect(partyEntry.ledgerName).toBe('ANU POLYMERS')
        expect(partyEntry.isDeemedPositive).toBe(true)
        expect(partyEntry.isPartyLedger).toBe(true)
        expect(partyEntry.amount).toBe(1180)
    })

    it('income items are Cr entries with negative amounts', () => {
        const doc = makeERPNextSalesInvoice()
        const result = erpSalesToTally(doc, config)

        // Second entry is the income account
        const incomeEntry = result.ledgerEntries[1]
        expect(incomeEntry.isDeemedPositive).toBe(false)
        expect(incomeEntry.amount).toBe(-23250)
    })

    it('GST tax entries are Cr with roundInr amounts', () => {
        const doc = makeERPNextSalesInvoice()
        const result = erpSalesToTally(doc, config)

        // Entries 2 and 3 are CGST and SGST
        const cgst = result.ledgerEntries[2]
        const sgst = result.ledgerEntries[3]
        expect(cgst.isDeemedPositive).toBe(false)
        expect(cgst.amount).toBe(-2947.5)
        expect(sgst.amount).toBe(-2947.5)
    })

    it('populates inventory entries from items', () => {
        const doc = makeERPNextSalesInvoice()
        const result = erpSalesToTally(doc, config)

        expect(result.inventoryEntries).toHaveLength(1)
        const inv = result.inventoryEntries[0]
        expect(inv.stockItemName).toBe('HDPE GRANULES')
        expect(inv.rate).toBe(93)
        expect(inv.billedQty).toBe(250)
        expect(inv.billedQtyUOM).toBe('KGS')
        expect(inv.hsnCode).toBe('999111')
    })

    it('bill allocation uses bill_no, fallback to INV-REF', () => {
        const withBillNo = makeERPNextSalesInvoice({ bill_no: 'MY-BILL-001' })
        const r1 = erpSalesToTally(withBillNo, config)
        expect(r1.ledgerEntries[0].billAllocations[0].name).toBe('MY-BILL-001')

        const withoutBillNo = makeERPNextSalesInvoice({ bill_no: undefined })
        const r2 = erpSalesToTally(withoutBillNo, config)
        expect(r2.ledgerEntries[0].billAllocations[0].name).toBe('INV-REF')
    })

    it('reverseMapAccount finds Tally name from ERPNext account', () => {
        const doc = makeERPNextSalesInvoice()
        const result = erpSalesToTally(doc, config)

        // income_account is '4110 - Sales - TC' which maps to 'B2B SALES' in config
        const incomeEntry = result.ledgerEntries[1]
        expect(incomeEntry.ledgerName).toBe('B2B SALES')
    })

    it('reverseMapAccount returns ERPNext account if no mapping', () => {
        const doc = makeERPNextSalesInvoice({
            items: [
                {
                    item_code: 'X',
                    item_name: 'X',
                    qty: 1,
                    uom: 'Nos',
                    rate: 100,
                    amount: 100,
                    income_account: 'Unmapped Account - TC',
                },
            ],
        })
        const result = erpSalesToTally(doc, config)

        const entry = result.ledgerEntries[1]
        expect(entry.ledgerName).toBe('Unmapped Account - TC')
    })

    it('guid uses custom_tally_guid, fallback to ERP-{name}', () => {
        const withGuid = makeERPNextSalesInvoice({ custom_tally_guid: 'my-tally-guid' })
        expect(erpSalesToTally(withGuid, config).guid).toBe('my-tally-guid')

        const withoutGuid = makeERPNextSalesInvoice({ custom_tally_guid: undefined, name: 'SINV-999' })
        expect(erpSalesToTally(withoutGuid, config).guid).toBe('ERP-SINV-999')
    })
})
