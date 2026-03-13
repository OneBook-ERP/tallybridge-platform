/**
 * Step 13 — Tally Sales/Credit Note → ERPNext Sales Invoice
 */
import type { TallyVoucher, CompanyConfig, ERPNextSalesInvoice, SalesInvoiceItem, TransformResult } from '../../types'
import { resolveAccount, isTransformError } from '../account-resolver'
import { resolveGST } from '../gst-resolver'
import { tallyDateToErp, absAmount, roundInr, sanitiseName, stateFromGstin } from '../utils'

const FALLBACK_STATE = 'Tamil Nadu' // only used if neither GSTIN nor config.defaultState is set

export function transformSales(voucher: TallyVoucher, config: CompanyConfig): TransformResult<ERPNextSalesInvoice> {
    const warnings: string[] = []

    // Determine if credit note (Sales Return)
    const isReturn =
        voucher.voucherTypeName.toLowerCase().includes('return') ||
        voucher.voucherTypeName.toLowerCase().includes('credit')

    // Derive company state from GSTIN if available
    const companyState =
        (config.companyGstin ? stateFromGstin(config.companyGstin) : null) ?? config.defaultState ?? FALLBACK_STATE

    // GST analysis
    const gst = resolveGST({
        voucher,
        config,
        companyState,
    })

    // GSTIN check — Tier 3 block for B2B without GSTIN
    if (!voucher.partyGSTIN && gst.gstCategory === 'Registered Regular') {
        return {
            success: false,
            error: {
                code: 'MISSING_GSTIN',
                message: `B2B party "${voucher.partyLedgerName}" has no GSTIN. Cannot create Sales Invoice.`,
                field: 'partyGSTIN',
            },
        }
    }

    // Build items from inventory entries
    const items: SalesInvoiceItem[] = []
    for (const inv of voucher.inventoryEntries) {
        // Resolve income account (from ACCOUNTINGALLOCATIONS or account mappings)
        const incomeAcct = inv.accountLedgerName
            ? resolveAccount(inv.accountLedgerName, config)
            : resolveAccount(inv.stockItemName, config)

        const defaultIncome =
            config.accountMappings['Default Income'] ??
            config.accountMappings['Sales'] ??
            config.accountMappings['Sales Account'] ??
            config.accountMappings['SALES'] ??
            'Sales'
        const actualAcct =
            !isTransformError(incomeAcct) && !incomeAcct.isPartyFallback ? incomeAcct.account : defaultIncome

        items.push({
            item_code: sanitiseName(inv.stockItemName),
            item_name: inv.stockItemName,
            qty: absAmount(inv.billedQty || inv.actualQty),
            uom: inv.billedQtyUOM || inv.actualQtyUOM || 'Nos',
            rate: absAmount(inv.rate),
            amount: absAmount(inv.amount),
            income_account: actualAcct,
            gst_hsn_code: inv.hsnCode || '',
        })

        if (!inv.hsnCode) {
            warnings.push(`Item "${inv.stockItemName}" has no HSN code — GST return may be incomplete.`)
        }
    }

    // If no inventory entries, use ledger entries to build items (service invoice)
    if (items.length === 0) {
        for (const le of voucher.ledgerEntries) {
            if (le.isPartyLedger) continue
            const resolved = resolveAccount(le.ledgerName, config)
            if (isTransformError(resolved)) {
                if (resolved.code === 'UNMAPPED_LEDGER') {
                    return { success: false, error: resolved }
                }
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
                income_account: resolved.account,
            })
        }
    }

    const total = roundInr(items.reduce((s, i) => s + i.amount, 0))
    const taxTotal = roundInr(gst.taxLines.reduce((s, t) => s + t.tax_amount, 0))
    const grandTotal = roundInr(total + taxTotal)

    const doc: ERPNextSalesInvoice = {
        doctype: 'Sales Invoice',
        customer: sanitiseName(voucher.partyLedgerName),
        company: config.erpnextCompany,
        posting_date: tallyDateToErp(voucher.date),
        bill_no: voucher.voucherNumber,
        is_return: isReturn ? 1 : 0,
        currency: config.currency,
        conversion_rate: 1,
        place_of_supply: gst.placeOfSupply,
        is_inter_state: gst.isInterState ? 1 : 0,
        gst_category: gst.gstCategory,
        customer_gstin: voucher.partyGSTIN || undefined,
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
