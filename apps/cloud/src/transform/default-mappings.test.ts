import { describe, it, expect } from 'vitest'
import { buildDefaultMappings, groupRootType, TALLY_GROUP_ROOT_TYPE } from './default-mappings'

describe('buildDefaultMappings', () => {
    it('returns 6 GST ledger mappings with correct suffix', () => {
        const { gstLedgerMappings } = buildDefaultMappings('XYZ')
        expect(gstLedgerMappings.output_cgst).toBe('Output Tax CGST - XYZ')
        expect(gstLedgerMappings.output_sgst).toBe('Output Tax SGST - XYZ')
        expect(gstLedgerMappings.output_igst).toBe('Output Tax IGST - XYZ')
        expect(gstLedgerMappings.input_cgst).toBe('Input Tax CGST - XYZ')
        expect(gstLedgerMappings.input_sgst).toBe('Input Tax SGST - XYZ')
        expect(gstLedgerMappings.input_igst).toBe('Input Tax IGST - XYZ')
    })

    it('returns standard voucher type mappings', () => {
        const { voucherTypeMappings } = buildDefaultMappings('ABC')
        expect(voucherTypeMappings['Sales']).toBe('Sales Invoice')
        expect(voucherTypeMappings['Purchase']).toBe('Purchase Invoice')
        expect(voucherTypeMappings['Payment']).toBe('Payment Entry')
        expect(voucherTypeMappings['Receipt']).toBe('Payment Entry')
        expect(voucherTypeMappings['Journal']).toBe('Journal Entry')
        expect(voucherTypeMappings['Contra']).toBe('Journal Entry')
        expect(voucherTypeMappings['Credit Note']).toBe('Sales Invoice')
        expect(voucherTypeMappings['Debit Note']).toBe('Purchase Invoice')
    })

    it('returns group default mappings with correct suffix', () => {
        const { groupDefaultMappings } = buildDefaultMappings('CPT')
        expect(groupDefaultMappings['Sales Accounts']).toBe('Sales - CPT')
        expect(groupDefaultMappings['Purchase Accounts']).toBe('Cost of Goods Sold - CPT')
        expect(groupDefaultMappings['Indirect Expenses']).toBe('Indirect Expenses - CPT')
        expect(groupDefaultMappings['Cash-in-Hand']).toBe('Cash - CPT')
        expect(groupDefaultMappings['Bank Accounts']).toBe('Bank Accounts - CPT')
        expect(groupDefaultMappings['Duties & Taxes']).toBe('Duties and Taxes - CPT')
    })

    it('works with empty abbr — no suffix appended', () => {
        const { gstLedgerMappings, groupDefaultMappings } = buildDefaultMappings('')
        expect(gstLedgerMappings.output_cgst).toBe('Output Tax CGST')
        expect(groupDefaultMappings['Sales Accounts']).toBe('Sales')
    })

    it('voucher type mappings are independent of abbr', () => {
        const a = buildDefaultMappings('ABC').voucherTypeMappings
        const b = buildDefaultMappings('XYZ').voucherTypeMappings
        expect(a).toEqual(b)
    })
})

describe('groupRootType', () => {
    it('classifies standard Tally groups correctly', () => {
        expect(groupRootType('Sundry Debtors')).toBe('Asset')
        expect(groupRootType('Sundry Creditors')).toBe('Liability')
        expect(groupRootType('Sales Accounts')).toBe('Income')
        expect(groupRootType('Purchase Accounts')).toBe('Expense')
        expect(groupRootType('Indirect Expenses')).toBe('Expense')
        expect(groupRootType('Direct Income')).toBe('Income')
        expect(groupRootType('Bank Accounts')).toBe('Asset')
        expect(groupRootType('Duties & Taxes')).toBe('Liability')
    })

    it('falls back to Expense for unknown groups', () => {
        expect(groupRootType('Custom Group')).toBe('Expense')
        expect(groupRootType('')).toBe('Expense')
    })
})

describe('TALLY_GROUP_ROOT_TYPE', () => {
    it('covers all 4 root types', () => {
        const types = new Set(Object.values(TALLY_GROUP_ROOT_TYPE))
        expect(types.has('Asset')).toBe(true)
        expect(types.has('Liability')).toBe(true)
        expect(types.has('Income')).toBe(true)
        expect(types.has('Expense')).toBe(true)
    })

    it('has at least 15 group entries', () => {
        expect(Object.keys(TALLY_GROUP_ROOT_TYPE).length).toBeGreaterThanOrEqual(15)
    })
})
