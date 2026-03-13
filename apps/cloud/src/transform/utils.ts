/**
 * Shared transform utilities used by all voucher transforms.
 */
import { createHash } from 'crypto'

/** Convert Tally date to "YYYY-MM-DD" for ERPNext.
 *  Accepts: "20240401" (yyyymmdd) or ISO 8601 "2024-04-01T00:00:00Z" from Go time.Time */
export function tallyDateToErp(tallyDate: string): string {
    if (!tallyDate) return ''
    // ISO 8601 format from Go's time.Time JSON serialization
    if (tallyDate.includes('-') || tallyDate.includes('T')) {
        const d = new Date(tallyDate)
        if (isNaN(d.getTime())) return ''
        return d.toISOString().slice(0, 10)
    }
    // Legacy yyyymmdd format
    if (tallyDate.length !== 8) return ''
    return `${tallyDate.slice(0, 4)}-${tallyDate.slice(4, 6)}-${tallyDate.slice(6, 8)}`
}

/** ERPNext date "2024-04-01" → Tally date "20240401" */
export function erpDateToTally(erpDate: string): string {
    return erpDate.replace(/-/g, '')
}

/** SHA-256 hash of a JSON-serialisable object — used for change detection */
export function contentHash(obj: unknown): string {
    return createHash('sha256').update(JSON.stringify(obj)).digest('hex')
}

/** Convert an absolute amount to a signed ERPNext amount.
 *  In ERPNext, debit amounts on the accounts[] are positive Dr,
 *  credit amounts are positive Cr (both fields, one is zero).
 *  For invoice amounts, the sign follows the total direction.
 */
export function absAmount(n: number): number {
    return Math.abs(n)
}

/** Round to 2 decimal places (paise) */
export function roundInr(n: number): number {
    return Math.round(n * 100) / 100
}

/** Sanitise a name for ERPNext: replace / : [ ] with safe chars. */
export function sanitiseName(name: string): string {
    return name
        .replace(/[/\\:[\]|*?<>]/g, '-')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 140) // ERPNext name field max length
}

/** True if a ledger entry is likely a round-off (amount < ₹1) */
export function isRoundOff(amount: number): boolean {
    return Math.abs(amount) < 1
}

/** Map of GSTIN state codes to state names */
const GSTIN_STATE_MAP: Record<string, string> = {
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

/** Derive state name from a GSTIN (first 2 digits are state code). */
export function stateFromGstin(gstin: string): string | null {
    if (!gstin || gstin.length < 2) return null
    return GSTIN_STATE_MAP[gstin.slice(0, 2)] ?? null
}
