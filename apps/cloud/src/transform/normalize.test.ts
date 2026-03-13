import { describe, it, expect } from 'vitest'
import { normalizeVoucher } from './normalize'
import { makePascalCaseVoucher, makeVoucher } from '../test/fixtures'

describe('normalizeVoucher', () => {
    it('passes through already-camelCase vouchers unchanged', () => {
        const v = makeVoucher() as unknown as Record<string, unknown>
        const result = normalizeVoucher(v)
        expect(result).toBe(v) // same reference — no copy
    })

    it('converts PascalCase top-level keys to camelCase', () => {
        const pascal = makePascalCaseVoucher()
        const result = normalizeVoucher(pascal)

        expect(result.guid).toBe('go-guid-001')
        expect(result.voucherTypeName).toBe('Sales')
        expect(result.voucherNumber).toBe('SI-GO-001')
        expect(result.partyLedgerName).toBe('Go Customer')
        expect(result.placeOfSupply).toBe('Tamil Nadu')
        expect(result.partyGSTIN).toBe('33AABCC9999D1ZA')
        expect(result.isOptional).toBe(false)
        expect(result.isCancelled).toBe(false)
        expect(result.narration).toBe('From Go')
    })

    it('converts nested ledger entries', () => {
        const pascal = makePascalCaseVoucher()
        const result = normalizeVoucher(pascal)

        const entries = result.ledgerEntries as Array<Record<string, unknown>>
        expect(entries).toHaveLength(2)
        expect(entries[0].ledgerName).toBe('Go Customer')
        expect(entries[0].isPartyLedger).toBe(true)
        expect(entries[0].isDeemedPositive).toBe(true)
        expect(entries[0].amount).toBe(11800)
    })

    it('converts nested bill allocations', () => {
        const pascal = makePascalCaseVoucher()
        const result = normalizeVoucher(pascal)

        const entries = result.ledgerEntries as Array<Record<string, unknown>>
        const bills = entries[0].billAllocations as Array<Record<string, unknown>>
        expect(bills).toHaveLength(1)
        expect(bills[0].name).toBe('SI-GO-001')
        expect(bills[0].billType).toBe('New Ref')
        expect(bills[0].amount).toBe(11800)
    })

    it('converts nested inventory entries', () => {
        const pascal = makePascalCaseVoucher()
        const result = normalizeVoucher(pascal)

        const inv = result.inventoryEntries as Array<Record<string, unknown>>
        expect(inv).toHaveLength(1)
        expect(inv[0].stockItemName).toBe('Go Widget')
        expect(inv[0].rate).toBe(100)
        expect(inv[0].hsnCode).toBe('84719000')
        expect(inv[0].accountLedgerName).toBe('B2B Sales')
    })

    it('preserves unknown keys (forward compatibility)', () => {
        const pascal = makePascalCaseVoucher()
        pascal['CustomField'] = 'custom-value'
        const result = normalizeVoucher(pascal)
        expect(result.CustomField).toBe('custom-value')
    })

    it('handles empty arrays gracefully', () => {
        const pascal = makePascalCaseVoucher()
        pascal.LedgerEntries = []
        pascal.InventoryEntries = []
        const result = normalizeVoucher(pascal)
        expect(result.ledgerEntries).toEqual([])
        expect(result.inventoryEntries).toEqual([])
    })

    it('handles missing nested arrays', () => {
        const pascal = makePascalCaseVoucher()
        delete pascal.LedgerEntries
        delete pascal.InventoryEntries
        const result = normalizeVoucher(pascal)
        expect(result.ledgerEntries).toBeUndefined()
        expect(result.inventoryEntries).toBeUndefined()
    })
})
