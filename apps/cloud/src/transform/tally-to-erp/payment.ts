/**
 * Step 13 — Tally Payment/Receipt → ERPNext Payment Entry
 *
 * Tally Payment (paying a supplier → payment_type=Pay)
 * Tally Receipt (receiving from customer → payment_type=Receive)
 *
 * Bank allocations → reference_no, reference_date
 * Bill allocations (Agst Ref) → Payment References linked to invoices
 */
import type { TallyVoucher, CompanyConfig, ERPNextPaymentEntry, PaymentReference, TransformResult } from '../../types'
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
    const referenceNo = bankAlloc?.uniqueReferenceNumber || bankAlloc?.instNumber || undefined
    const referenceDate = referenceNo ? tallyDateToErp(voucher.date) : undefined

    // Bill allocations (Agst Ref) → payment references
    const references: PaymentReference[] = []
    for (const le of voucher.ledgerEntries) {
        for (const ba of le.billAllocations) {
            if (ba.billType !== 'Agst Ref') continue
            // reference_name will be resolved by sync engine against sync_records table
            references.push({
                reference_doctype: isReceipt ? 'Sales Invoice' : 'Purchase Invoice',
                reference_name: ba.name, // voucher number — engine will resolve to name
                allocated_amount: absAmount(ba.amount),
            })
        }
    }

    const doc: ERPNextPaymentEntry = {
        doctype: 'Payment Entry',
        payment_type: paymentType,
        posting_date: tallyDateToErp(voucher.date),
        party_type: partyType,
        party: sanitiseName(voucher.partyLedgerName),
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
        references,
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
