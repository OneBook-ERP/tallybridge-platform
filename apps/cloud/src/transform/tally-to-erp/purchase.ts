/**
 * Step 13 — Tally Purchase/Debit Note → ERPNext Purchase Invoice
 */
import type {
    TallyVoucher,
    CompanyConfig,
    ERPNextPurchaseInvoice,
    PurchaseInvoiceItem,
    TransformResult,
} from '../../types'
import { resolveAccount, isTransformError } from '../account-resolver'
import { resolveGST } from '../gst-resolver'
import { tallyDateToErp, absAmount, roundInr, sanitiseName, stateFromGstin } from '../utils'

const FALLBACK_STATE = 'Tamil Nadu' // only used if neither GSTIN nor config.defaultState is set

export function transformPurchase(
    voucher: TallyVoucher,
    config: CompanyConfig,
): TransformResult<ERPNextPurchaseInvoice> {
    const warnings: string[] = []
    const isReturn =
        voucher.voucherTypeName.toLowerCase().includes('debit') ||
        voucher.voucherTypeName.toLowerCase().includes('return')

    const companyState =
        (config.companyGstin ? stateFromGstin(config.companyGstin) : null) ?? config.defaultState ?? FALLBACK_STATE
    const gst = resolveGST({ voucher, config, companyState })

    const items: PurchaseInvoiceItem[] = []
    for (const inv of voucher.inventoryEntries) {
        const expAcct = inv.accountLedgerName
            ? resolveAccount(inv.accountLedgerName, config)
            : resolveAccount(inv.stockItemName, config)
        const defaultExpense =
            config.accountMappings['Default Purchase'] ??
            config.accountMappings['Purchase'] ??
            config.accountMappings['Purchase Account'] ??
            config.accountMappings['PURCHASE'] ??
            'Cost of Goods Sold'
        const actualAcct = !isTransformError(expAcct) && !expAcct.isPartyFallback ? expAcct.account : defaultExpense

        items.push({
            item_code: sanitiseName(inv.stockItemName),
            item_name: inv.stockItemName,
            qty: absAmount(inv.billedQty || inv.actualQty),
            uom: inv.billedQtyUOM || inv.actualQtyUOM || 'Nos',
            rate: absAmount(inv.rate),
            amount: absAmount(inv.amount),
            expense_account: actualAcct,
            gst_hsn_code: inv.hsnCode || '',
        })
        if (!inv.hsnCode) warnings.push(`Item "${inv.stockItemName}" has no HSN code.`)
    }

    // Service purchase — no inventory entries
    if (items.length === 0) {
        for (const le of voucher.ledgerEntries) {
            if (le.isPartyLedger) continue
            const resolved = resolveAccount(le.ledgerName, config)
            if (isTransformError(resolved)) {
                if (resolved.code === 'UNMAPPED_LEDGER') return { success: false, error: resolved }
                continue
            }
            if (resolved.isRoundOff || resolved.isGST) continue
            if (resolved.account === '__IGNORE__') continue
            const amt = absAmount(le.amount)
            items.push({
                item_code: sanitiseName(le.ledgerName),
                item_name: le.ledgerName,
                qty: 1,
                uom: 'Nos',
                rate: amt,
                amount: amt,
                expense_account: resolved.account,
            })
        }
    }

    const total = roundInr(items.reduce((s, i) => s + i.amount, 0))
    const taxTotal = roundInr(gst.taxLines.reduce((s, t) => s + t.tax_amount, 0))
    const grandTotal = roundInr(total + taxTotal)

    const doc: ERPNextPurchaseInvoice = {
        doctype: 'Purchase Invoice',
        supplier: sanitiseName(voucher.partyLedgerName),
        company: config.erpnextCompany,
        posting_date: tallyDateToErp(voucher.date),
        bill_date: voucher.referenceDate ? tallyDateToErp(voucher.referenceDate) : undefined,
        bill_no: voucher.referenceNumber || voucher.voucherNumber,
        is_return: isReturn ? 1 : 0,
        currency: config.currency,
        conversion_rate: 1,
        is_inter_state: gst.isInterState ? 1 : 0,
        gst_category: gst.gstCategory,
        supplier_gstin: voucher.partyGSTIN || undefined,
        company_gstin: config.companyGstin || undefined,
        company_address: config.companyGstin ? `${config.erpnextCompany}-Billing` : undefined,
        is_rcm_applicable: gst.isRCM ? 1 : 0,
        remarks: voucher.narration || undefined,
        items,
        taxes: gst.taxLines,
        total,
        total_taxes_and_charges: taxTotal,
        grand_total: grandTotal,
        custom_tally_guid: voucher.guid,
        custom_tally_voucher_number: voucher.voucherNumber,
        custom_tally_sync_status: 'Pending',
        custom_sync_source: 'TALLYBRIDGE',
    }

    return { success: true, doc, warnings }
}
