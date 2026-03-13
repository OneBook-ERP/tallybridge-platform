import { describe, it, expect } from 'vitest'
import { resolveAccount, isTransformError } from './account-resolver'
import { makeConfig } from '../test/fixtures'

describe('resolveAccount', () => {
    const config = makeConfig()

    it('resolves exact match from accountMappings', () => {
        const result = resolveAccount('B2B Sales', config)
        expect(isTransformError(result)).toBe(false)
        if (!isTransformError(result)) {
            expect(result.account).toBe('Sales - TC')
            expect(result.isGST).toBe(false)
            expect(result.isRoundOff).toBe(false)
        }
    })

    it('detects output CGST ledger', () => {
        const result = resolveAccount('Output CGST 9%', config)
        expect(isTransformError(result)).toBe(false)
        if (!isTransformError(result)) {
            expect(result.isGST).toBe(true)
            expect(result.gstType).toBe('output_cgst')
            expect(result.account).toBe('Output Tax CGST - TC')
        }
    })

    it('detects output SGST ledger', () => {
        const result = resolveAccount('Output SGST 9%', config)
        expect(isTransformError(result)).toBe(false)
        if (!isTransformError(result)) {
            expect(result.isGST).toBe(true)
            expect(result.gstType).toBe('output_sgst')
        }
    })

    it('detects output IGST ledger', () => {
        const result = resolveAccount('Output IGST 18%', config)
        expect(isTransformError(result)).toBe(false)
        if (!isTransformError(result)) {
            expect(result.isGST).toBe(true)
            expect(result.gstType).toBe('output_igst')
        }
    })

    it('detects input CGST ledger', () => {
        const result = resolveAccount('Input CGST 9%', config)
        expect(isTransformError(result)).toBe(false)
        if (!isTransformError(result)) {
            expect(result.isGST).toBe(true)
            expect(result.gstType).toBe('input_cgst')
        }
    })

    it('detects input SGST from "purchase" keyword', () => {
        const result = resolveAccount('Purchase SGST 9%', config)
        expect(isTransformError(result)).toBe(false)
        if (!isTransformError(result)) {
            expect(result.isGST).toBe(true)
            expect(result.gstType).toBe('input_sgst')
        }
    })

    it('detects round-off ledger', () => {
        const result = resolveAccount('Round Off', config)
        expect(isTransformError(result)).toBe(false)
        if (!isTransformError(result)) {
            expect(result.isRoundOff).toBe(true)
            expect(result.account).toBe('__ROUND_OFF__')
        }
    })

    it('detects rounding variation', () => {
        const result = resolveAccount('Rounding Adjustment', config)
        expect(isTransformError(result)).toBe(false)
        if (!isTransformError(result)) {
            expect(result.isRoundOff).toBe(true)
        }
    })

    it('returns UNMAPPED_LEDGER error for unknown ledger', () => {
        const result = resolveAccount('Unknown Expense', config)
        expect(isTransformError(result)).toBe(true)
        if (isTransformError(result)) {
            expect(result.code).toBe('UNMAPPED_LEDGER')
            expect(result.field).toBe('Unknown Expense')
        }
    })
})

describe('isTransformError', () => {
    it('returns true for error objects', () => {
        expect(isTransformError({ code: 'UNMAPPED_LEDGER', message: 'test' })).toBe(true)
    })

    it('returns false for resolved account objects', () => {
        expect(isTransformError({ account: 'Sales', isRoundOff: false, isGST: false })).toBe(false)
    })
})
