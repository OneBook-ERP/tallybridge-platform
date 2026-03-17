/**
 * Tests for ERPNext Stock Entry → Tally Stock Journal Voucher transform.
 */
import { describe, it, expect } from 'vitest'
import { buildStockVoucherXML } from './stock'
import { makeConfig } from '../../test/fixtures'
import type { ERPNextStockEntry } from '../../types'

function makeStockEntry(overrides: Partial<ERPNextStockEntry> = {}): ERPNextStockEntry {
    return {
        doctype: 'Stock Entry',
        name: 'STE-2023-00001',
        stock_entry_type: 'Material Issue',
        posting_date: '2023-06-20',
        company: 'Test Company',
        items: [
            {
                item_code: 'HDPE GRANULES',
                item_name: 'HDPE GRANULES',
                qty: 100,
                uom: 'KGS',
                s_warehouse: 'Stores - TC',
                basic_rate: 93,
                amount: 9300,
            },
        ],
        custom_tally_guid: 'test-guid-001',
        ...overrides,
    }
}

describe('buildStockVoucherXML', () => {
    const config = makeConfig({ erpnextAbbr: 'TC', defaultWarehouse: 'Stores - TC' })

    it('Material Issue → voucherType=Stock Journal, issue item has isDeemedPositive=false', () => {
        const entry = makeStockEntry({ stock_entry_type: 'Material Issue' })
        const result = buildStockVoucherXML(entry, config)

        expect(result.voucherType).toBe('Stock Journal')
        expect(result.stockJournalEntries).toHaveLength(1)
        expect(result.stockJournalEntries[0].isDeemedPositive).toBe(false)
    })

    it('Material Receipt → receipt item has isDeemedPositive=true', () => {
        const entry = makeStockEntry({
            stock_entry_type: 'Material Receipt',
            items: [
                {
                    item_code: 'HDPE GRANULES',
                    qty: 100,
                    uom: 'KGS',
                    t_warehouse: 'Stores - TC',
                    basic_rate: 93,
                    amount: 9300,
                },
            ],
        })
        const result = buildStockVoucherXML(entry, config)

        expect(result.stockJournalEntries).toHaveLength(1)
        expect(result.stockJournalEntries[0].isDeemedPositive).toBe(true)
    })

    it('Material Transfer Entry → two entries per item (issue + receipt)', () => {
        const entry = makeStockEntry({
            stock_entry_type: 'Material Transfer Entry',
            items: [
                {
                    item_code: 'HDPE GRANULES',
                    qty: 50,
                    uom: 'KGS',
                    s_warehouse: 'Godown A - TC',
                    t_warehouse: 'Godown B - TC',
                    basic_rate: 93,
                    amount: 4650,
                },
            ],
        })
        const result = buildStockVoucherXML(entry, config)

        // Two entries for the one item: one issue (false) + one receipt (true)
        expect(result.stockJournalEntries).toHaveLength(2)
        const issueEntry = result.stockJournalEntries.find((e) => !e.isDeemedPositive)
        const receiptEntry = result.stockJournalEntries.find((e) => e.isDeemedPositive)
        expect(issueEntry).toBeDefined()
        expect(receiptEntry).toBeDefined()
        expect(issueEntry?.godownName).toBe('Godown A')
        expect(receiptEntry?.godownName).toBe('Godown B')
    })

    it('strips ERPNext ABBR suffix from warehouse → Tally godown name', () => {
        const entry = makeStockEntry({
            stock_entry_type: 'Material Issue',
            items: [{ item_code: 'ITEM-A', qty: 10, uom: 'Nos', s_warehouse: 'Cold Storage - TC', basic_rate: 50, amount: 500 }],
        })
        const result = buildStockVoucherXML(entry, config)

        expect(result.stockJournalEntries[0].godownName).toBe('Cold Storage')
    })

    it('Stores warehouse maps to Main Location godown', () => {
        const entry = makeStockEntry({
            stock_entry_type: 'Material Issue',
            items: [{ item_code: 'ITEM-B', qty: 5, uom: 'Nos', s_warehouse: 'Stores - TC', basic_rate: 100, amount: 500 }],
        })
        const result = buildStockVoucherXML(entry, config)

        expect(result.stockJournalEntries[0].godownName).toBe('Main Location')
    })

    it('uses custom_tally_guid as guid when present', () => {
        const entry = makeStockEntry({ custom_tally_guid: 'TALLY-GUID-XYZ' })
        const result = buildStockVoucherXML(entry, config)

        expect(result.guid).toBe('TALLY-GUID-XYZ')
    })

    it('falls back to ERP-name when no custom_tally_guid', () => {
        const entry = makeStockEntry({ custom_tally_guid: undefined, name: 'STE-001' })
        const result = buildStockVoucherXML(entry, config)

        expect(result.guid).toBe('ERP-STE-001')
    })

    it('Material Issue adds stock-in-hand ledger entry (credit)', () => {
        const entry = makeStockEntry({ stock_entry_type: 'Material Issue' })
        const result = buildStockVoucherXML(entry, config)

        // Should have at least one ledger entry balancing the stock movement
        expect(result.ledgerEntries).toHaveLength(1)
        expect(result.ledgerEntries[0].isDeemedPositive).toBe(false) // credit
    })

    it('Material Receipt adds stock-in-hand ledger entry (debit)', () => {
        const entry = makeStockEntry({
            stock_entry_type: 'Material Receipt',
            items: [{ item_code: 'ITEM-X', qty: 10, uom: 'Nos', t_warehouse: 'Stores - TC', basic_rate: 50, amount: 500 }],
        })
        const result = buildStockVoucherXML(entry, config)

        expect(result.ledgerEntries).toHaveLength(1)
        expect(result.ledgerEntries[0].isDeemedPositive).toBe(true) // debit
    })

    it('Material Transfer has no ledger entries (zero-net)', () => {
        const entry = makeStockEntry({
            stock_entry_type: 'Material Transfer Entry',
            items: [
                { item_code: 'ITEM-X', qty: 10, uom: 'Nos', s_warehouse: 'A - TC', t_warehouse: 'B - TC', basic_rate: 50, amount: 500 },
            ],
        })
        const result = buildStockVoucherXML(entry, config)

        expect(result.ledgerEntries).toHaveLength(0)
    })

    it('isInvoice is always false for stock entries', () => {
        const result = buildStockVoucherXML(makeStockEntry(), config)
        expect(result.isInvoice).toBe(false)
    })

    it('CREATE action sets action field', () => {
        const result = buildStockVoucherXML(makeStockEntry(), config, 'CREATE')
        expect(result.action).toBe('CREATE')
    })

    it('CANCEL action propagates to result', () => {
        const result = buildStockVoucherXML(makeStockEntry(), config, 'CANCEL')
        expect(result.action).toBe('CANCEL')
    })
})
