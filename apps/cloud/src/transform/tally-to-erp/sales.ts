/**
 * Step 13 — Tally Sales/Credit Note → ERPNext Sales Invoice
 */
import type { TallyVoucher, CompanyConfig, ERPNextSalesInvoice, SalesInvoiceItem, TransformResult } from '../../types'
import { resolveAccount, isTransformError } from '../account-resolver'
import { resolveGST } from '../gst-resolver'
import { tallyDateToErp, absAmount, roundInr, sanitiseName, stateFromGstin, validGstin } from '../utils'

const FALLBACK_STATE = '' // last resort: no GSTIN and no defaultState configured — caller should handle empty

export function transformSales(voucher: TallyVoucher, config: CompanyConfig): TransformResult<ERPNextSalesInvoice> {
    const warnings: string[] = []

    // Determine if credit note (Sales Return).
    // Priority 1: explicit voucher type name pattern (most reliable)
    // Priority 2: all party ledger amounts are positive/debit → customer is being debited = return
    // Priority 3: all inventory quantities are negative (Tally returns recorded as regular Sales)
    const vtLower = voucher.voucherTypeName.toLowerCase()
    const isReturnByName =
        /credit.?note|sales.?return|cn/i.test(voucher.voucherTypeName) ||
        vtLower.includes('return') ||
        vtLower.includes('credit')

    // Party amount fallback: if the party ledger is CREDITED (negative amount = credit to customer),
    // this signals a return — the customer was given money back rather than being charged.
    // Normal Sales: customer Dr (amount positive, isDeemedPositive=true)
    // Sales Return: customer Cr (amount negative, isDeemedPositive=false)
    const partyEntries = voucher.ledgerEntries.filter((e) => e.isPartyLedger)
    const totalPartyAmount = partyEntries.reduce((s, e) => s + e.amount, 0)
    const isReturnByPartyAmount = !isReturnByName && partyEntries.length > 0 && totalPartyAmount < 0

    const isReturnByQty =
        !isReturnByName &&
        !isReturnByPartyAmount &&
        voucher.inventoryEntries.length > 0 &&
        voucher.inventoryEntries.every((e) => e.billedQty < 0 || e.actualQty < 0)
    const isReturn = isReturnByName || isReturnByPartyAmount || isReturnByQty

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

        const qty = absAmount(inv.billedQty || inv.actualQty) || 1
        items.push({
            item_code: sanitiseName(inv.stockItemName),
            item_name: inv.stockItemName,
            qty: isReturn ? -qty : qty,
            uom: inv.billedQtyUOM || inv.actualQtyUOM || 'Nos',
            rate: absAmount(inv.rate),
            amount: absAmount(inv.amount),
            income_account: actualAcct,
            gst_hsn_code: inv.hsnCode || '999111',
            allow_zero_valuation_rate: 1,
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

    // Due date: use bill allocation due date from Tally, fallback to posting date.
    // Filter out zero/invalid dates (Go zero time marshals to "0001-01-01T00:00:00Z").
    const postingDate = tallyDateToErp(voucher.date)
    const tallyDueDate = voucher.ledgerEntries.flatMap((le) => le.billAllocations).find((ba) => ba.dueDate)?.dueDate
    const derivedDueDate = tallyDueDate ? tallyDateToErp(tallyDueDate) : ''
    // Due date must be same or later than posting date; fall back to posting date if missing or earlier
    const dueDate = derivedDueDate && derivedDueDate >= postingDate ? derivedDueDate : postingDate

    // Multi-currency: compute conversion_rate from foreignAmount / totalAmount
    const hasForeignCurrency = !!voucher.foreignCurrency && voucher.foreignCurrency !== 'INR'
    const computedCurrency = hasForeignCurrency ? voucher.foreignCurrency : (config.currency ?? 'INR')
    const computedConversionRate =
        hasForeignCurrency && voucher.foreignAmount && grandTotal ? roundInr(voucher.foreignAmount / grandTotal) : 1

    // Address: join address lines from voucher (populated by engine from ledger_masters raw_data)
    const customerAddressStr =
        Array.isArray(voucher.address) && voucher.address.length > 0 ? voucher.address.join('\n') : undefined

    // IRN and e-Way Bill fields (irnNo/irn both handled; normalizer maps both)
    const irnValue = voucher.irn || voucher.irnNo || undefined
    const irnAckNo = voucher.irnAckNo || undefined
    const eWayBill = voucher.ewayBillNumber || undefined

    const doc: ERPNextSalesInvoice = {
        doctype: 'Sales Invoice',
        customer: sanitiseName(voucher.partyLedgerName),
        company: config.erpnextCompany,
        posting_date: postingDate,
        due_date: dueDate,
        set_posting_time: 1,
        bill_no: voucher.voucherNumber,
        update_stock: voucher.inventoryEntries.length > 0 && config.defaultWarehouse ? 1 : 0,
        set_warehouse:
            voucher.inventoryEntries.length > 0 && config.defaultWarehouse ? config.defaultWarehouse : undefined,
        is_return: isReturn ? 1 : 0,
        currency: computedCurrency,
        conversion_rate: computedConversionRate,
        place_of_supply: gst.placeOfSupply,
        is_inter_state: gst.isInterState ? 1 : 0,
        gst_category: gst.gstCategory,
        customer_gstin: validGstin(voucher.partyGSTIN),
        company_gstin: config.companyGstin || undefined,
        company_address:
            config.companyAddress || (config.companyGstin ? `${config.erpnextCompany}-Billing` : undefined),
        is_rcm_applicable: gst.isRCM ? 1 : 0,
        ignore_pricing_rule: 1,
        remarks: voucher.narration || undefined,
        // Address sync
        customer_address: customerAddressStr,
        shipping_address_name: customerAddressStr,
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
