/**
 * Step 15 — GST resolver.
 * Determines inter-state status, GST category, and builds tax lines from
 * Tally's GST ledger entries.
 *
 * PRD edge cases handled:
 *  - Mixed rate invoices (different GST rates on different lines)
 *  - RCM detection
 *  - Inter-state determination from PlaceOfSupply vs company state
 *  - Composition scheme detection (GSTIN 2nd char = '4')
 *  - B2C / Unregistered / Overseas classification
 */
import type { TallyVoucher, TaxLine, GSTCategory, CompanyConfig } from '../types'
import { resolveAccount, isTransformError } from './account-resolver'

// Map of Indian state codes → state names (used for inter-state detection)
const STATE_CODES: Record<string, string> = {
    '01': 'Jammu and Kashmir',
    '02': 'Himachal Pradesh',
    '03': 'Punjab',
    '04': 'Chandigarh',
    '05': 'Uttarakhand',
    '06': 'Haryana',
    '07': 'Delhi',
    '08': 'Rajasthan',
    '09': 'Uttar Pradesh',
    '10': 'Bihar',
    '11': 'Sikkim',
    '12': 'Arunachal Pradesh',
    '13': 'Nagaland',
    '14': 'Manipur',
    '15': 'Mizoram',
    '16': 'Tripura',
    '17': 'Meghalaya',
    '18': 'Assam',
    '19': 'West Bengal',
    '20': 'Jharkhand',
    '21': 'Odisha',
    '22': 'Chhattisgarh',
    '23': 'Madhya Pradesh',
    '24': 'Gujarat',
    '26': 'Dadra and Nagar Haveli',
    '27': 'Maharashtra',
    '29': 'Karnataka',
    '30': 'Goa',
    '31': 'Lakshadweep',
    '32': 'Kerala',
    '33': 'Tamil Nadu',
    '34': 'Puducherry',
    '35': 'Andaman and Nicobar Islands',
    '36': 'Telangana',
    '37': 'Andhra Pradesh',
}

export interface GSTAnalysis {
    isInterState: boolean
    gstCategory: GSTCategory
    placeOfSupply: string // "27-Maharashtra" format for ERPNext
    taxLines: TaxLine[]
    isRCM: boolean
}

export interface GSTResolverParams {
    voucher: TallyVoucher
    config: CompanyConfig
    companyState: string // company's home state name e.g. "Maharashtra"
}

/**
 * Analyse a voucher's GST situation and produce tax lines.
 */
export function resolveGST(params: GSTResolverParams): GSTAnalysis {
    const { voucher, config, companyState } = params

    // ── GST category & party classification ──────────────────────────────────
    const gstCategory = classifyGSTCategory(voucher.partyGSTIN, voucher.placeOfSupply)

    // ── Inter-state detection ────────────────────────────────────────────────
    const partyState = parseStateName(voucher.placeOfSupply)
    const isInterState = !!partyState && partyState.toLowerCase() !== companyState.toLowerCase()

    // ── Place of supply in ERPNext format ───────────────────────────────────
    const stateCode = stateNameToCode(partyState || companyState)
    const placeOfSupply = stateCode ? `${stateCode}-${partyState || companyState}` : partyState || companyState

    // ── Compute net total (non-party, non-GST ledger amounts) for rate calc ──
    let netTotal = 0
    for (const le of voucher.ledgerEntries) {
        if (le.isPartyLedger) continue
        const r = resolveAccount(le.ledgerName, config)
        if (isTransformError(r) || r.isGST || r.isRoundOff) continue
        netTotal += Math.abs(le.amount)
    }

    // ── Build tax lines from GST ledger entries ──────────────────────────────
    const taxLines: TaxLine[] = []
    for (const le of voucher.ledgerEntries) {
        const resolved = resolveAccount(le.ledgerName, config)
        if (isTransformError(resolved)) continue // non-GST ledger
        if (!resolved.isGST) continue

        const absAmount = Math.abs(le.amount)
        if (absAmount === 0) continue

        // Determine rate: first try ledger name (e.g. "Output CGST 9%"),
        // then derive from tax_amount / netTotal so India Compliance accepts "On Net Total".
        const rateMatch = le.ledgerName.match(/(\d+(?:\.\d+)?)\s*%/)
        const derivedRate = rateMatch
            ? parseFloat(rateMatch[1])
            : netTotal > 0
              ? Math.round((absAmount / netTotal) * 100 * 100) / 100
              : 0

        taxLines.push({
            charge_type: 'On Net Total',
            account_head: resolved.account,
            tax_amount: absAmount,
            rate: derivedRate,
            description: le.ledgerName,
        } as TaxLine)
    }

    return {
        isInterState,
        gstCategory,
        placeOfSupply,
        taxLines,
        isRCM: voucher.isRCMApplicable,
    }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function classifyGSTCategory(gstin: string, placeOfSupply: string): GSTCategory {
    if (!gstin) {
        // B2C or overseas based on place of supply
        const state = parseStateName(placeOfSupply)
        if (!state) return 'Overseas'
        return 'Unregistered'
    }
    // GSTIN 2nd character '4' = Composition Dealer
    if (gstin.length >= 2 && gstin[1] === '4') return 'Registered Composition'
    // Validate basic GSTIN format (15 chars, starts with state code)
    if (gstin.length === 15) return 'Registered Regular'
    return 'Unregistered'
}

function parseStateName(placeOfSupply: string): string {
    if (!placeOfSupply) return ''
    // Could be "Maharashtra" or "27-Maharashtra" or "27"
    const clean = placeOfSupply.trim()
    const codeMatch = clean.match(/^(\d{2})-(.+)$/)
    if (codeMatch) return codeMatch[2].trim()
    return clean
}

function stateNameToCode(stateName: string): string | null {
    const norm = stateName.toLowerCase().trim()
    for (const [code, name] of Object.entries(STATE_CODES)) {
        if (name.toLowerCase() === norm) return code
    }
    return null
}
