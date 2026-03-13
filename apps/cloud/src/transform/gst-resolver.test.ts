import { describe, it, expect } from 'vitest'
import { resolveGST } from './gst-resolver'
import { makeConfig, makeVoucher } from '../test/fixtures'

describe('resolveGST', () => {
    const config = makeConfig()
    const companyState = 'Tamil Nadu'

    it('detects intra-state transaction (TN → TN)', () => {
        const voucher = makeVoucher({ placeOfSupply: 'Tamil Nadu' })
        const result = resolveGST({ voucher, config, companyState })

        expect(result.isInterState).toBe(false)
        expect(result.placeOfSupply).toContain('Tamil Nadu')
    })

    it('detects inter-state transaction (TN → MH)', () => {
        const voucher = makeVoucher({ placeOfSupply: 'Maharashtra' })
        const result = resolveGST({ voucher, config, companyState })

        expect(result.isInterState).toBe(true)
        expect(result.placeOfSupply).toContain('Maharashtra')
    })

    it('handles place of supply in "code-name" format', () => {
        const voucher = makeVoucher({ placeOfSupply: '27-Maharashtra' })
        const result = resolveGST({ voucher, config, companyState })

        expect(result.isInterState).toBe(true)
        expect(result.placeOfSupply).toContain('Maharashtra')
    })

    it('classifies registered regular for valid 15-char GSTIN', () => {
        const voucher = makeVoucher({ partyGSTIN: '33AABCC1234D1ZA' })
        const result = resolveGST({ voucher, config, companyState })

        expect(result.gstCategory).toBe('Registered Regular')
    })

    it('classifies unregistered when no GSTIN', () => {
        const voucher = makeVoucher({ partyGSTIN: '', placeOfSupply: 'Tamil Nadu' })
        const result = resolveGST({ voucher, config, companyState })

        expect(result.gstCategory).toBe('Unregistered')
    })

    it('classifies overseas when no GSTIN and no place of supply', () => {
        const voucher = makeVoucher({ partyGSTIN: '', placeOfSupply: '' })
        const result = resolveGST({ voucher, config, companyState })

        expect(result.gstCategory).toBe('Overseas')
    })

    it('classifies composition dealer when GSTIN 2nd char is 4', () => {
        const voucher = makeVoucher({ partyGSTIN: '34AABCC1234D1ZA' })
        const result = resolveGST({ voucher, config, companyState })

        expect(result.gstCategory).toBe('Registered Composition')
    })

    it('builds tax lines from GST ledger entries', () => {
        const voucher = makeVoucher() // has Output CGST 9% and Output SGST 9% entries
        const result = resolveGST({ voucher, config, companyState })

        expect(result.taxLines.length).toBeGreaterThanOrEqual(2)
        const cgstLine = result.taxLines.find((t) => t.account_head === 'Output Tax CGST - TC')
        const sgstLine = result.taxLines.find((t) => t.account_head === 'Output Tax SGST - TC')
        expect(cgstLine).toBeDefined()
        expect(sgstLine).toBeDefined()
        expect(cgstLine!.tax_amount).toBe(900)
        expect(sgstLine!.tax_amount).toBe(900)
    })

    it('derives rate from ledger name percentage pattern', () => {
        const voucher = makeVoucher()
        const result = resolveGST({ voucher, config, companyState })

        const cgstLine = result.taxLines.find((t) => t.account_head === 'Output Tax CGST - TC')
        expect(cgstLine!.rate).toBe(9)
    })

    it('reports RCM status from voucher', () => {
        const voucher = makeVoucher({ isRCMApplicable: true })
        const result = resolveGST({ voucher, config, companyState })

        expect(result.isRCM).toBe(true)
    })

    it('case-insensitive state comparison', () => {
        const voucher = makeVoucher({ placeOfSupply: 'tamil nadu' })
        const result = resolveGST({ voucher, config, companyState })

        expect(result.isInterState).toBe(false)
    })
})
