/**
 * Step 13 — Tally Payment/Receipt → ERPNext Payment Entry
 *
 * Tally Payment (paying a supplier → payment_type=Pay)
 * Tally Receipt (receiving from customer → payment_type=Receive)
 *
 * Bank allocations → reference_no, reference_date
 * Bill allocations (Agst Ref) → Payment References linked to invoices
 */
import type {
    TallyVoucher,
    CompanyConfig,
    ERPNextPaymentEntry,
    PaymentReference,
    AdvancePaymentEntry,
    TransformResult,
} from '../../types'
import { resolveAccount, isTransformError } from '../account-resolver'
import { tallyDateToErp, absAmount, roundInr, sanitiseName, isRoundOff } from '../utils'

export function transformPayment(voucher: TallyVoucher, config: CompanyConfig): TransformResult<ERPNextPaymentEntry> {
    const isReceipt = voucher.voucherTypeName.toLowerCase().includes('receipt')
    const paymentType = isReceipt ? 'Receive' : 'Pay'
    const partyType = isReceipt ? 'Customer' : 'Supplier'

    // Find party ledger entry — try isPartyLedger flag first, then match by partyLedgerName
    const partyEntry =
        voucher.ledgerEntries.find((le) => le.isPartyLedger) ??
        voucher.ledgerEntries.find((le) => le.ledgerName === voucher.partyLedgerName)

    if (!partyEntry) {
        return {
            success: false,
            error: {
                code: 'TRANSFORM_FAILED',
                message: 'Payment voucher has no party ledger entry',
                field: 'ledgerEntries',
            },
        }
    }

    // If the party ledger is a bank/cash account (bank-to-bank transfer), this should be a
    // Journal Entry (Contra), not a Payment Entry. Signal the router to fall back.
    const bankLedgers = config.bankLedgers ?? []
    if (bankLedgers.includes(partyEntry.ledgerName)) {
        return {
            success: false,
            error: {
                code: 'FALLBACK_TO_JOURNAL',
                message: `Party ledger "${partyEntry.ledgerName}" is a bank/cash account — route as Journal Entry`,
            },
        }
    }

    // Find bank/cash ledger entry (non-party, non-round-off)
    let bankEntry = voucher.ledgerEntries.find(
        (le) =>
            le !== partyEntry &&
            !le.isPartyLedger &&
            le.ledgerName !== voucher.partyLedgerName &&
            !isRoundOff(le.amount),
    )
    if (!bankEntry) bankEntry = voucher.ledgerEntries.find((le) => le !== partyEntry && !isRoundOff(le.amount))
    if (!bankEntry) bankEntry = voucher.ledgerEntries.find((le) => le !== partyEntry)
    const bankResolved = resolveAccount(bankEntry?.ledgerName ?? '', config, {
        isPartyLedger: bankEntry?.isPartyLedger,
        partyLedgerName: voucher.partyLedgerName,
    })
    if (isTransformError(bankResolved)) {
        if (bankResolved.code === 'UNMAPPED_LEDGER') return { success: false, error: bankResolved }
    }
    const bankAccount =
        !isTransformError(bankResolved) && !bankResolved.isRoundOff && bankResolved.account !== '__IGNORE__'
            ? bankResolved.account
            : (config.accountMappings['Cash'] ?? 'Cash')

    const amount = roundInr(absAmount(partyEntry.amount))

    // Bank allocation → UTR / cheque details
    const bankAlloc = partyEntry.bankAllocations?.[0] ?? bankEntry?.bankAllocations?.[0]
    // ERPNext requires non-empty reference_no/date for bank account transactions.
    // Chain through all available sources; final fallback uses last 12 chars of GUID so it's always unique and non-empty.
    const referenceNo =
        bankAlloc?.uniqueReferenceNumber ||
        bankAlloc?.instNumber ||
        voucher.voucherNumber ||
        `TLY-${voucher.guid.slice(-12)}`
    const referenceDate = tallyDateToErp(voucher.date) || new Date().toISOString().slice(0, 10)

    // Bill allocations → payment references (Agst Ref) and advance entries (Advance)
    const references: PaymentReference[] = []
    const advanceEntries: AdvancePaymentEntry[] = []
    let hasOnAccountAllocation = false

    for (const le of voucher.ledgerEntries) {
        for (const ba of le.billAllocations) {
            if (ba.billType === 'Agst Ref') {
                // reference_name will be resolved by sync engine against sync_records table
                references.push({
                    reference_doctype: isReceipt ? 'Sales Invoice' : 'Purchase Invoice',
                    reference_name: ba.name, // voucher number — engine will resolve to name
                    allocated_amount: absAmount(ba.amount),
                })
            } else if (ba.billType === 'Advance') {
                // Advance payment: track separately
                advanceEntries.push({
                    reference_type: isReceipt ? 'Sales Invoice' : 'Purchase Invoice',
                    reference_name: ba.name,
                    advance_amount: absAmount(ba.amount),
                    allocated_amount: absAmount(ba.amount),
                })
            } else if (ba.billType === 'New Ref') {
                // "On Account" / new reference: payment without prior invoice reference
                hasOnAccountAllocation = true
            }
        }
    }

    // When Advance bill allocations are present and this is a "Pay" type,
    // override paid_to to point at the advance ledger account (party's payable).
    // For On Account payments (no prior invoice), references will be empty — unallocated.
    const effectivePaymentType = advanceEntries.length > 0 && !isReceipt ? 'Pay' : paymentType

    const partyName = sanitiseName(partyEntry.ledgerName || voucher.partyLedgerName || 'Unknown Party')

    const doc: ERPNextPaymentEntry = {
        doctype: 'Payment Entry',
        payment_type: effectivePaymentType,
        posting_date: tallyDateToErp(voucher.date),
        party_type: partyType,
        party: partyName,
        company: config.erpnextCompany,
        paid_from: isReceipt ? debtorsAccount(config) : bankAccount,
        paid_to: isReceipt ? bankAccount : creditorsAccount(config),
        paid_from_account_currency: config.currency,
        paid_to_account_currency: config.currency,
        paid_amount: amount,
        received_amount: amount,
        source_exchange_rate: 1,
        target_exchange_rate: 1,
        reference_no: referenceNo,
        reference_date: referenceDate,
        remarks: voucher.narration || undefined,
        // On Account payments: references is intentionally empty (unallocated)
        references: hasOnAccountAllocation && references.length === 0 ? [] : references,
        advance_payment_entries: advanceEntries.length > 0 ? advanceEntries : undefined,
        cost_center: config.costCenter || undefined,
        company_gstin: config.companyGstin || undefined,
        custom_tally_guid: voucher.guid,
        custom_tally_voucher_number: voucher.voucherNumber,
        custom_sync_source: 'TALLYBRIDGE',
    }

    return { success: true, doc, warnings: [] }
}

/** Get Debtors account from config mappings, falling back to abbreviation-based name */
function debtorsAccount(config: CompanyConfig): string {
    return (
        config.accountMappings['Sundry Debtors'] ??
        config.accountMappings['Debtors'] ??
        `Debtors - ${config.erpnextAbbr ?? shortCo(config.erpnextCompany)}`
    )
}

/** Get Creditors account from config mappings, falling back to abbreviation-based name */
function creditorsAccount(config: CompanyConfig): string {
    return (
        config.accountMappings['Sundry Creditors'] ??
        config.accountMappings['Creditors'] ??
        `Creditors - ${config.erpnextAbbr ?? shortCo(config.erpnextCompany)}`
    )
}

/** Short company suffix for default AR/AP accounts e.g. "AC" from "Acme Corp" */
function shortCo(company: string): string {
    return company
        .split(' ')
        .map((w) => w[0])
        .join('')
        .toUpperCase()
        .slice(0, 3)
}
