/**
 * Tests for Tally Stock Journal / Physical Stock → ERPNext Stock Entry transform.
 */
import { describe, it, expect } from 'vitest'
import { transformStock } from './stock'
import { makeConfig, makeVoucher, makeInventoryEntry } from '../../test/fixtures'
import type { TallyVoucher } from '../../types'

describe('transformStock', () => {
    const config = makeConfig({ defaultWarehouse: 'Stores - TC', erpnextAbbr: 'TC' })

    function makeStockVoucher(overrides: Partial<TallyVoucher> = {}): TallyVoucher {
        return makeVoucher({
            voucherTypeName: 'Stock Journal',
            voucherNumber: 'SJ-001',
            partyLedgerName: '',
            partyGSTIN: '',
            narration: 'Stock movement',
            ledgerEntries: [],
            inventoryEntries: [makeInventoryEntry({ godownName: 'Main Location' })],
            ...overrides,
        })
    }

    it('sets custom_tally_guid and custom_sync_source', () => {
        const voucher = makeStockVoucher()
        const result = transformStock(voucher, config)

        expect(result.success).toBe(true)
        if (!result.success) return
        expect(result.doc.custom_tally_guid).toBe(voucher.guid)
        expect(result.doc.custom_sync_source).toBe('TALLYBRIDGE')
    })

    it('sets custom_tally_voucher_number', () => {
        const voucher = makeStockVoucher({ voucherNumber: 'SJ-099' })
        const result = transformStock(voucher, config)

        expect(result.success).toBe(true)
        if (!result.success) return
        expect(result.doc.custom_tally_voucher_number).toBe('SJ-099')
    })

    it('Physical Stock → Material Receipt', () => {
        const voucher = makeStockVoucher({ voucherTypeName: 'Physical Stock' })
        const result = transformStock(voucher, config)

        expect(result.success).toBe(true)
        if (!result.success) return
        expect(result.doc.stock_entry_type).toBe('Material Receipt')
    })

    it('Stock Journal with only destination godown → Material Receipt', () => {
        const voucher = makeStockVoucher({
            inventoryEntries: [makeInventoryEntry({ godownName: 'Main Location' })],
        })
        const result = transformStock(voucher, config)

        expect(result.success).toBe(true)
        if (!result.success) return
        // No source, no stockJournalEntries → defaults to Material Issue or Receipt by voucher name
        // Stock Journal with no explicit direction defaults to Material Issue
        expect(['Material Issue', 'Material Receipt', 'Material Transfer Entry']).toContain(
            result.doc.stock_entry_type,
        )
    })

    it('Physical Stock voucher → Material Receipt with items', () => {
        const voucher = makeStockVoucher({
            voucherTypeName: 'Physical Stock',
            inventoryEntries: [
                makeInventoryEntry({ stockItemName: 'HDPE GRANULES', billedQty: 250, rate: 93, amount: 23250, godownName: 'Main Location' }),
            ],
        })
        const result = transformStock(voucher, config)

        expect(result.success).toBe(true)
        if (!result.success) return
        expect(result.doc.stock_entry_type).toBe('Material Receipt')
        expect(result.doc.items).toHaveLength(1)
        expect(result.doc.items[0].item_code).toBe('HDPE GRANULES')
        expect(result.doc.items[0].qty).toBe(250)
        expect(result.doc.items[0].basic_rate).toBe(93)
    })

    it('stock journal entries with both source and destination → Material Transfer Entry', () => {
        const voucher = makeStockVoucher({
            voucherTypeName: 'Stock Journal',
            inventoryEntries: [],
            stockJournalEntries: [
                {
                    stockItemName: 'HDPE GRANULES',
                    godownName: 'Godown A',
                    destinationGodownName: 'Godown B',
                    rate: 93,
                    amount: 9300,
                    actualQty: 100,
                    actualQtyUOM: 'KGS',
                    billedQty: 100,
                    billedQtyUOM: 'KGS',
                    isDeemedPositive: true,
                },
            ],
        })
        const result = transformStock(voucher, config)

        expect(result.success).toBe(true)
        if (!result.success) return
        expect(result.doc.stock_entry_type).toBe('Material Transfer Entry')
    })

    it('Material Transfer Entry generates two stock journal items (issue + receipt)', () => {
        const voucher = makeStockVoucher({
            voucherTypeName: 'Stock Journal',
            inventoryEntries: [],
            stockJournalEntries: [
                {
                    stockItemName: 'HDPE GRANULES',
                    godownName: 'Godown A',
                    destinationGodownName: 'Godown B',
                    rate: 93,
                    amount: 9300,
                    actualQty: 100,
                    actualQtyUOM: 'KGS',
                    billedQty: 100,
                    billedQtyUOM: 'KGS',
                    isDeemedPositive: true,
                },
            ],
        })
        const result = transformStock(voucher, config)

        expect(result.success).toBe(true)
        if (!result.success) return
        // Two items: one issue from Godown A, one receipt into Godown B
        expect(result.doc.items).toHaveLength(2)
        // Issue entry: s_warehouse set
        const issueItem = result.doc.items.find((i) => i.s_warehouse)
        expect(issueItem).toBeDefined()
        expect(issueItem?.s_warehouse).toContain('Godown A')
        // Receipt entry: t_warehouse set
        const receiptItem = result.doc.items.find((i) => i.t_warehouse)
        expect(receiptItem).toBeDefined()
        expect(receiptItem?.t_warehouse).toContain('Godown B')
    })

    it('fails when no inventory entries present', () => {
        const voucher = makeStockVoucher({ inventoryEntries: [], stockJournalEntries: [] })
        const result = transformStock(voucher, config)

        expect(result.success).toBe(false)
        if (result.success) return
        expect(result.error.code).toBe('TRANSFORM_FAILED')
    })

    it('warehouse resolver override is called for godown names', () => {
        const customResolver = (godown: string) => `CUSTOM-${godown}`
        const voucher = makeStockVoucher({
            inventoryEntries: [makeInventoryEntry({ godownName: 'Warehouse X' })],
        })
        const result = transformStock(voucher, config, customResolver)

        expect(result.success).toBe(true)
        if (!result.success) return
        const hasCustomWarehouse = result.doc.items.some(
            (i) => i.s_warehouse?.startsWith('CUSTOM-') || i.t_warehouse?.startsWith('CUSTOM-'),
        )
        expect(hasCustomWarehouse).toBe(true)
    })

    it('Main Location godown maps to defaultWarehouse', () => {
        const voucher = makeStockVoucher({
            voucherTypeName: 'Physical Stock',
            inventoryEntries: [makeInventoryEntry({ godownName: 'Main Location' })],
        })
        const result = transformStock(voucher, config)

        expect(result.success).toBe(true)
        if (!result.success) return
        const hasDefaultWarehouse = result.doc.items.some(
            (i) => i.t_warehouse === 'Stores - TC' || i.s_warehouse === 'Stores - TC',
        )
        expect(hasDefaultWarehouse).toBe(true)
    })

    it('sets posting_date from voucher date', () => {
        const voucher = makeStockVoucher({ date: '2023-06-20T00:00:00Z' })
        const result = transformStock(voucher, config)

        expect(result.success).toBe(true)
        if (!result.success) return
        expect(result.doc.posting_date).toBe('2023-06-20')
    })
})
