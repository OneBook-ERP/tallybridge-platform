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
import { tallyDateToErp, absAmount, roundInr, sanitiseName, stateFromGstin, validGstin } from '../utils'

const FALLBACK_STATE = 'Tamil Nadu' // only used if neither GSTIN nor config.defaultState is set

export function transformPurchase(
    voucher: TallyVoucher,
    config: CompanyConfig,
): TransformResult<ERPNextPurchaseInvoice> {
    const warnings: string[] = []
    // Detect returns: check voucher type name first (most reliable), then
    // party amount direction, then fall back to negative inventory quantities.
    const vtLower = voucher.voucherTypeName.toLowerCase()
    const isReturnByName =
        /debit.?note|purchase.?return|dn/i.test(voucher.voucherTypeName) ||
        vtLower.includes('debit') ||
        vtLower.includes('return')

    // Fallback: for a Debit Note / Purchase Return, the supplier is DEBITED (amount positive = Dr to supplier).
    // Normal Purchase: supplier Cr (amount negative, isDeemedPositive=false)
    // Purchase Return: supplier Dr (amount positive, isDeemedPositive=true) — we're reducing our payable
    const partyEntries = voucher.ledgerEntries.filter((e) => e.isPartyLedger)
    const totalPartyAmount = partyEntries.reduce((s, e) => s + e.amount, 0)
    const isReturnByPartyAmount = !isReturnByName && partyEntries.length > 0 && totalPartyAmount > 0

    const isReturnByQty =
        !isReturnByName &&
        !isReturnByPartyAmount &&
        voucher.inventoryEntries.length > 0 &&
        voucher.inventoryEntries.every((e) => e.billedQty < 0 || e.actualQty < 0)
    const isReturn = isReturnByName || isReturnByPartyAmount || isReturnByQty

    const companyState =
        (config.companyGstin ? stateFromGstin(config.companyGstin) : null) ?? config.defaultState ?? FALLBACK_STATE
    const gst = resolveGST({ voucher, config, companyState })

    // For Unregistered or Composition Scheme suppliers, input GST cannot be claimed.
    // India Compliance rejects tax lines for these categories on Purchase Invoices.
    if (gst.gstCategory === 'Unregistered' || gst.gstCategory === 'Registered Composition') {
        gst.taxLines = []
    }

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

        const qty = absAmount(inv.billedQty || inv.actualQty) || 1
        // When update_stock=1, ERPNext requires expense_account to be the warehouse
        // valuation account (Stock In Hand), not COGS — use config mapping if available.
        const stockAcct = config.defaultWarehouse
            ? (config.accountMappings['Stock In Hand'] ??
              config.accountMappings['Closing Stock'] ??
              undefined)
            : actualAcct
        items.push({
            item_code: sanitiseName(inv.stockItemName),
            item_name: inv.stockItemName,
            qty: isReturn ? -qty : qty,
            uom: inv.billedQtyUOM || inv.actualQtyUOM || 'Nos',
            rate: absAmount(inv.rate),
            amount: absAmount(inv.amount),
            expense_account: stockAcct,
            gst_hsn_code: inv.hsnCode || '999111',
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

    // Dates: use Tally's actual dates, fallback to posting date
    const postingDate = tallyDateToErp(voucher.date)
    const billDate = voucher.referenceDate ? tallyDateToErp(voucher.referenceDate) : postingDate
    const tallyDueDate = voucher.ledgerEntries.flatMap((le) => le.billAllocations).find((ba) => ba.dueDate)?.dueDate
    const derivedDueDate = tallyDueDate ? tallyDateToErp(tallyDueDate) : ''
    // Due date must be same or later than posting date; fall back to posting date if missing or earlier
    const dueDate = derivedDueDate && derivedDueDate >= postingDate ? derivedDueDate : postingDate

    // Multi-currency support
    const hasForeignCurrency = !!voucher.foreignCurrency && voucher.foreignCurrency !== 'INR'
    const computedCurrency = hasForeignCurrency ? voucher.foreignCurrency : (config.currency ?? 'INR')
    const computedConversionRate =
        hasForeignCurrency && voucher.foreignAmount && grandTotal
            ? roundInr(voucher.foreignAmount / grandTotal)
            : 1

    // Address sync
    const supplierAddressStr =
        Array.isArray(voucher.address) && voucher.address.length > 0
            ? voucher.address.join('\n')
            : undefined

    // e-Invoice / e-Way Bill fields
    const irnValue = (voucher.irn || voucher.irnNo) || undefined
    const irnAckNo = voucher.irnAckNo || undefined
    const eWayBill = voucher.ewayBillNumber || undefined

    const doc: ERPNextPurchaseInvoice = {
        doctype: 'Purchase Invoice',
        supplier: sanitiseName(voucher.partyLedgerName),
        company: config.erpnextCompany,
        posting_date: postingDate,
        due_date: dueDate,
        bill_date: billDate,
        bill_no: voucher.referenceNumber || voucher.voucherNumber,
        set_posting_time: 1,
        update_stock: voucher.inventoryEntries.length > 0 && config.defaultWarehouse ? 1 : 0,
        set_warehouse:
            voucher.inventoryEntries.length > 0 && config.defaultWarehouse ? config.defaultWarehouse : undefined,
        is_return: isReturn ? 1 : 0,
        currency: computedCurrency,
        conversion_rate: computedConversionRate,
        is_inter_state: gst.isInterState ? 1 : 0,
        gst_category: gst.gstCategory,
        supplier_gstin: validGstin(voucher.partyGSTIN),
        company_gstin: config.companyGstin || undefined,
        company_address:
            config.companyAddress || (config.companyGstin ? `${config.erpnextCompany}-Billing` : undefined),
        is_rcm_applicable: gst.isRCM ? 1 : 0,
        remarks: voucher.narration || undefined,
        // Address sync
        supplier_address: supplierAddressStr,
        contact_email: voucher.partyEmail || undefined,
        items,
        taxes: gst.taxLines,
        total,
        total_taxes_and_charges: taxTotal,
        grand_total: grandTotal,
        custom_tally_guid: voucher.guid,
        custom_tally_voucher_number: voucher.voucherNumber,
        custom_tally_sync_status: 'Pending',
        custom_sync_source: 'TALLYBRIDGE',
        // e-Invoice / e-Way Bill
        custom_ewaybill_no: eWayBill,
        custom_irn: irnValue,
        custom_irn_ack_no: irnAckNo,
    }

    return { success: true, doc, warnings }
}
