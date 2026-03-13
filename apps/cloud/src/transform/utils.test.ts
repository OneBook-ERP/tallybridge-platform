import { describe, it, expect } from 'vitest'
import {
    tallyDateToErp,
    erpDateToTally,
    contentHash,
    absAmount,
    roundInr,
    sanitiseName,
    isRoundOff,
    stateFromGstin,
} from './utils'

describe('tallyDateToErp', () => {
    it('converts yyyymmdd format', () => {
        expect(tallyDateToErp('20240401')).toBe('2024-04-01')
    })

    it('converts ISO 8601 format from Go time.Time', () => {
        expect(tallyDateToErp('2024-04-01T00:00:00Z')).toBe('2024-04-01')
    })

    it('converts ISO 8601 with timezone offset', () => {
        expect(tallyDateToErp('2024-04-01T05:30:00+05:30')).toBe('2024-04-01')
    })

    it('handles date-only ISO format', () => {
        expect(tallyDateToErp('2024-04-01')).toBe('2024-04-01')
    })

    it('returns empty string for empty input', () => {
        expect(tallyDateToErp('')).toBe('')
    })

    it('returns empty string for invalid yyyymmdd length', () => {
        expect(tallyDateToErp('2024')).toBe('')
    })

    it('returns empty string for invalid ISO date', () => {
        expect(tallyDateToErp('not-a-date')).toBe('')
    })
})

describe('erpDateToTally', () => {
    it('strips hyphens from YYYY-MM-DD', () => {
        expect(erpDateToTally('2024-04-01')).toBe('20240401')
    })
})

describe('contentHash', () => {
    it('produces consistent SHA-256 hash', () => {
        const h1 = contentHash({ a: 1 })
        const h2 = contentHash({ a: 1 })
        expect(h1).toBe(h2)
        expect(h1).toHaveLength(64) // SHA-256 hex
    })

    it('produces different hashes for different inputs', () => {
        expect(contentHash({ a: 1 })).not.toBe(contentHash({ a: 2 }))
    })
})

describe('absAmount', () => {
    it('returns absolute value of negative number', () => {
        expect(absAmount(-1500)).toBe(1500)
    })

    it('returns positive number unchanged', () => {
        expect(absAmount(1500)).toBe(1500)
    })

    it('returns 0 for 0', () => {
        expect(absAmount(0)).toBe(0)
    })
})

describe('roundInr', () => {
    it('rounds to 2 decimal places', () => {
        expect(roundInr(100.456)).toBe(100.46)
    })

    it('keeps exact 2 decimal values', () => {
        expect(roundInr(100.45)).toBe(100.45)
    })

    it('handles banker rounding edge (0.005)', () => {
        expect(roundInr(100.005)).toBe(100.01)
    })
})

describe('sanitiseName', () => {
    it('replaces forbidden chars with hyphens', () => {
        expect(sanitiseName('Sales/Return [2024]')).toBe('Sales-Return -2024-')
    })

    it('collapses multiple spaces', () => {
        expect(sanitiseName('Customer   Name')).toBe('Customer Name')
    })

    it('trims whitespace', () => {
        expect(sanitiseName('  Customer  ')).toBe('Customer')
    })

    it('truncates to 140 chars', () => {
        const long = 'A'.repeat(200)
        expect(sanitiseName(long)).toHaveLength(140)
    })
})

describe('isRoundOff', () => {
    it('returns true for amounts under 1 rupee', () => {
        expect(isRoundOff(0.5)).toBe(true)
        expect(isRoundOff(-0.3)).toBe(true)
    })

    it('returns false for amounts >= 1 rupee', () => {
        expect(isRoundOff(1)).toBe(false)
        expect(isRoundOff(-1.5)).toBe(false)
    })
})

describe('stateFromGstin', () => {
    it('returns Tamil Nadu for state code 33', () => {
        expect(stateFromGstin('33AABCT1234A1ZA')).toBe('Tamil Nadu')
    })

    it('returns Maharashtra for state code 27', () => {
        expect(stateFromGstin('27AABCM5678B1ZB')).toBe('Maharashtra')
    })

    it('returns Gujarat for state code 24', () => {
        expect(stateFromGstin('24AABCG9012C1ZC')).toBe('Gujarat')
    })

    it('returns Delhi for state code 07', () => {
        expect(stateFromGstin('07AABCD3456D1ZD')).toBe('Delhi')
    })

    it('returns null for empty string', () => {
        expect(stateFromGstin('')).toBeNull()
    })

    it('returns null for short string', () => {
        expect(stateFromGstin('3')).toBeNull()
    })

    it('returns null for unknown state code', () => {
        expect(stateFromGstin('99UNKNOWN')).toBeNull()
    })
})
