import { describe, it, expect } from 'vitest'
import { resolveAccount, isTransformError } from './account-resolver'
import { makeConfig } from '../test/fixtures'

describe('resolveAccount', () => {
    const config = makeConfig()

    it('resolves exact match from accountMappings', () => {
        const result = resolveAccount('B2B SALES', config)
        expect(isTransformError(result)).toBe(false)
        if (!isTransformError(result)) {
            expect(result.account).toBe('4110 - Sales - TC')
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

    it('returns UNMAPPED_LEDGER error for unknown expense ledger', () => {
        const result = resolveAccount('Unknown Expense', config)
        expect(isTransformError(result)).toBe(true)
        if (isTransformError(result)) {
            expect(result.code).toBe('UNMAPPED_LEDGER')
            expect(result.field).toBe('Unknown Expense')
        }
    })
})

describe('party ledger resolution', () => {
    const config = makeConfig()

    it('resolves as Debtors when isPartyLedger is true', () => {
        const result = resolveAccount('Some Customer Name', config, { isPartyLedger: true })
        expect(isTransformError(result)).toBe(false)
        if (!isTransformError(result)) {
            expect(result.account).toBe('1310 - Debtors - TC')
            expect(result.isPartyFallback).toBe(true)
        }
    })

    it('resolves as Creditors when partyDirection is creditor', () => {
        const result = resolveAccount('Some Supplier', config, {
            isPartyLedger: true,
            partyDirection: 'creditor',
        })
        expect(isTransformError(result)).toBe(false)
        if (!isTransformError(result)) {
            expect(result.account).toBe('2110 - Creditors - TC')
            expect(result.isPartyFallback).toBe(true)
        }
    })

    it('resolves via partyLedgerName match', () => {
        const result = resolveAccount('Ratan Enterprises', config, {
            partyLedgerName: 'Ratan Enterprises',
        })
        expect(isTransformError(result)).toBe(false)
        if (!isTransformError(result)) {
            expect(result.account).toBe('1310 - Debtors - TC')
            expect(result.isPartyFallback).toBe(true)
        }
    })

    it('falls back to derived suffix when Debtors mapping is absent', () => {
        const bareConfig = makeConfig({ accountMappings: {} })
        const result = resolveAccount('Some Customer', bareConfig, { isPartyLedger: true })
        expect(isTransformError(result)).toBe(false)
        if (!isTransformError(result)) {
            // "Test Company" → "TC" (first letter of each word, max 3)
            expect(result.account).toBe('Debtors - TC')
        }
    })
})

describe('aggressive party detection', () => {
    const config = makeConfig()

    it('resolves person-like name as party (no expense keywords)', () => {
        const result = resolveAccount('Ratan Enterprises Pvt Ltd', config)
        expect(isTransformError(result)).toBe(false)
        if (!isTransformError(result)) {
            expect(result.isPartyFallback).toBe(true)
            expect(result.account).toBe('1310 - Debtors - TC')
        }
    })

    it('does NOT resolve expense-keyword ledger as party', () => {
        const expenseNames = [
            'Additional Handling Charges',
            'Freight Expenses',
            'Bank Interest',
            'Depreciation on Assets',
            'Rent Payable',
            'Staff Salary',
            'Revenue Account',
            'Discount Allowed',
            'Cash in Hand',
            'Capital Reserve',
            'Profit and Loss',
        ]
        for (const name of expenseNames) {
            const result = resolveAccount(name, config)
            expect(isTransformError(result)).toBe(true)
            if (isTransformError(result)) {
                expect(result.code).toBe('UNMAPPED_LEDGER')
            }
        }
    })

    it('uses creditor direction for aggressive detection when specified', () => {
        const result = resolveAccount('ABC Traders', config, { partyDirection: 'creditor' })
        expect(isTransformError(result)).toBe(false)
        if (!isTransformError(result)) {
            expect(result.account).toBe('2110 - Creditors - TC')
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
