/**
 * Step 15 — Account resolver.
 * Maps Tally ledger names → ERPNext account names using the company config.
 *
 * Resolution order (PRD 5.3):
 *  1. Exact match in config.accountMappings
 *  2. Round-off detection (auto-corrected, Tier 1)
 *  3. GST ledger pattern match (CGST/SGST/IGST)
 *  4. Party ledger fallback (Debtors/Creditors) when isPartyLedger hint is provided
 *  5. Throw TIER-3 exception with unmapped ledger name
 */
import type { CompanyConfig, TransformError } from '../types'

const ROUND_OFF_PATTERNS = /round(?:ed)?[\s-]?off|rounding/i

export type ResolvedAccount = {
    account: string
    isRoundOff: boolean
    isGST: boolean
    isPartyFallback?: boolean
    gstType?: 'output_cgst' | 'output_sgst' | 'output_igst' | 'input_cgst' | 'input_sgst' | 'input_igst'
}

export interface ResolveOptions {
    /** Hint from Tally's ISPARTYLEDGER flag on the ledger entry */
    isPartyLedger?: boolean
    /** If known, the party direction: 'debtor' or 'creditor' */
    partyDirection?: 'debtor' | 'creditor'
    /** Voucher-level party ledger name — if ledger matches this, it's definitely a party */
    partyLedgerName?: string
}

/**
 * Resolve a single Tally ledger name to an ERPNext account.
 * Returns a TransformError with code UNMAPPED_LEDGER if not found.
 *
 * When opts.isPartyLedger is true and no explicit mapping exists, falls back
 * to Debtors / Creditors account automatically — party ledgers don't need
 * individual mappings since they represent the customer/supplier sub-ledger.
 */
export function resolveAccount(
    tallyLedger: string,
    config: CompanyConfig,
    opts?: ResolveOptions,
): ResolvedAccount | TransformError {
    // 1. GST pattern first — prevents GST ledgers shadowed by accountMappings
    //    from being resolved as non-GST accounts.
    const gstType = detectGSTLedgerType(tallyLedger, config)
    if (gstType) {
        const account = config.gstLedgerMappings[gstType] ?? config.accountMappings[tallyLedger]
        if (account) return { account, isRoundOff: false, isGST: true, gstType }
    }

    // 2. Round-off auto-correction (Tier 1 — no exception needed)
    if (ROUND_OFF_PATTERNS.test(tallyLedger)) {
        return { account: '__ROUND_OFF__', isRoundOff: true, isGST: false }
    }

    // 3. Exact match in accountMappings
    const direct = config.accountMappings[tallyLedger]
    if (direct === '__IGNORE__') return { account: '__IGNORE__', isRoundOff: true, isGST: false }
    if (direct) return { account: direct, isRoundOff: false, isGST: false }

    // 4. Party ledger fallback — triggered by Tally's ISPARTYLEDGER flag,
    //    OR by matching the voucher-level partyLedgerName.
    const isKnownParty = opts?.isPartyLedger || (opts?.partyLedgerName && tallyLedger === opts.partyLedgerName)
    if (isKnownParty) {
        return resolveAsParty(config, opts?.partyDirection)
    }

    // 5. Aggressive party detection — if the ledger name doesn't contain
    //    expense/income/tax keywords, it's almost certainly a customer/supplier
    //    party name (Tally often doesn't set ISPARTYLEDGER on journal entries).
    if (!EXPENSE_KEYWORDS.test(tallyLedger)) {
        return resolveAsParty(config, opts?.partyDirection)
    }

    // 6. Unmapped — Tier 3 exception
    return {
        code: 'UNMAPPED_LEDGER',
        message: `Tally ledger "${tallyLedger}" has no ERPNext account mapping. Add it to account_mappings in config.`,
        field: tallyLedger,
    }
}

/** Resolve a ledger as a party (Debtor/Creditor) based on direction hint. */
function resolveAsParty(config: CompanyConfig, direction?: 'debtor' | 'creditor'): ResolvedAccount {
    const suffix = config.erpnextAbbr ?? deriveCompanySuffix(config.erpnextCompany)
    if (direction === 'creditor') {
        const acct =
            config.accountMappings['Sundry Creditors'] ?? config.accountMappings['Creditors'] ?? `Creditors - ${suffix}`
        return { account: acct, isRoundOff: false, isGST: false, isPartyFallback: true }
    }
    const acct = config.accountMappings['Sundry Debtors'] ?? config.accountMappings['Debtors'] ?? `Debtors - ${suffix}`
    return { account: acct, isRoundOff: false, isGST: false, isPartyFallback: true }
}

/**
 * Regex to detect expense/income/tax/bank keywords in ledger names.
 * If a name matches, it's NOT a party — it's an unmapped expense account.
 * Party names (company/person names) won't contain these keywords.
 */
const EXPENSE_KEYWORDS =
    /\b(charges?|expenses?|interest|tax|depreciation|rent|salary|insurance|dut(?:y|ies)|cess|income|payable|receivable|provision|advance\s+tax|tds|tcs|assets?\s+dep|maintena?n[cs]e|stall|warehouse|service\s+charge|transaction\s+fee|membership|consumable|staff\s*welfare|bonus|commission|revenue|account|ledger|discount|freight|packing|loading|unloading|clearing|forwarding|brokerage|bad\s+debts?|sundry|misc|general|opening|closing|stock|cash|bank|capital|reserve|profit|loss|suspense|control|destuffing|examination|customs|formalities|container|audit|legal|petrol|diesel|courier|postage|electricity|water|telephone|mobile|printing|stationery|donation|penalty|fine)\b/i

/** Derive company abbreviation suffix from company name (e.g. "Acme Corp Ltd" → "ACL") */
function deriveCompanySuffix(company: string): string {
    return company
        .split(/\s+/)
        .map((w) => w[0]?.toUpperCase() ?? '')
        .join('')
        .slice(0, 3)
}

export function isTransformError(x: ResolvedAccount | TransformError): x is TransformError {
    return 'code' in x
}

// ── GST ledger name detection ─────────────────────────────────────────────────
// Tally GST ledger names follow patterns like "Output CGST 9%", "Input IGST 18%"

function detectGSTLedgerType(name: string, _config: CompanyConfig): keyof CompanyConfig['gstLedgerMappings'] | null {
    const n = name.toLowerCase()
    const isInput = n.includes('input') || n.includes('purchase') || n.includes('inward') || n.includes('itc')

    if (n.includes('cgst')) return isInput ? 'input_cgst' : 'output_cgst'
    if (n.includes('sgst') || n.includes('utgst')) return isInput ? 'input_sgst' : 'output_sgst'
    if (n.includes('igst')) return isInput ? 'input_igst' : 'output_igst'

    // Secondary: rate-only patterns — "18% GST", "@18"
    const rateMatch = n.match(/[@\s](\d+)%?\s*(gst|tax)/i)
    if (rateMatch) {
        const rate = parseInt(rateMatch[1], 10)
        if ([5, 12, 18, 28].includes(rate)) {
            return isInput ? 'input_igst' : 'output_igst'
        }
    }

    return null
}
