/**
 * Tally Stock Journal / Physical Stock → ERPNext Stock Entry
 */
import type { TallyVoucher, CompanyConfig, ERPNextStockEntry, StockEntryItem, TransformResult } from '../../types'
import { tallyDateToErp, absAmount, sanitiseName } from '../utils'

/**
 * Detect the ERPNext stock_entry_type from the Tally voucher type name and
 * whether source / destination godowns are present in inventory entries.
 */
function detectStockEntryType(
    voucherTypeName: string,
    hasSource: boolean,
    hasDestination: boolean,
): ERPNextStockEntry['stock_entry_type'] {
    const vtLower = voucherTypeName.toLowerCase()

    // Physical Stock / Opening Stock → Material Receipt
    if (/physical|opening.?stock/i.test(voucherTypeName)) {
        return 'Material Receipt'
    }

    // If both source AND destination godowns exist → Material Transfer Entry
    if (hasSource && hasDestination) {
        return 'Material Transfer Entry'
    }

    // Only destination present → Material Receipt
    if (!hasSource && hasDestination) {
        return 'Material Receipt'
    }

    // Only source present → Material Issue
    if (hasSource && !hasDestination) {
        return 'Material Issue'
    }

    // Fallback: use voucher type name hints
    if (vtLower.includes('receipt') || vtLower.includes('inward')) {
        return 'Material Receipt'
    }
    if (vtLower.includes('transfer')) {
        return 'Material Transfer Entry'
    }
    // Default: Material Issue
    return 'Material Issue'
}

export function transformStock(
    voucher: TallyVoucher,
    config: CompanyConfig,
    warehouseResolver?: (godown: string) => string,
): TransformResult<ERPNextStockEntry> {
    // Must have inventory entries to create a Stock Entry
    if (voucher.inventoryEntries.length === 0 && (!voucher.stockJournalEntries || voucher.stockJournalEntries.length === 0)) {
        return {
            success: false,
            error: {
                code: 'TRANSFORM_FAILED',
                message: 'Stock voucher has no inventory entries',
                field: 'inventoryEntries',
            },
        }
    }

    const defaultWarehouse = config.defaultWarehouse ?? `Stores - ${config.erpnextAbbr ?? 'CPT'}`

    // Default resolver: godown name → warehouse (strips ERPNext ABBR suffix if present, else appends it)
    const resolveWarehouse = warehouseResolver ?? ((godown: string): string => {
        if (!godown || godown.toLowerCase() === 'main location' || godown === '') {
            return defaultWarehouse
        }
        const abbr = config.erpnextAbbr ?? 'CPT'
        // If already has " - ABBR" suffix, return as-is
        if (godown.endsWith(` - ${abbr}`)) return godown
        return `${godown} - ${abbr}`
    })

    // Determine if entries have source and/or destination godowns
    // Stock journal entries have explicit godownName / destinationGodownName
    const entries = voucher.stockJournalEntries ?? []
    const hasStockJournalEntries = entries.length > 0
    const hasSource = hasStockJournalEntries
        ? entries.some((e) => !!e.godownName)
        : voucher.inventoryEntries.some((e) => !!e.godownName)
    const hasDestination = hasStockJournalEntries
        ? entries.some((e) => !!e.destinationGodownName)
        : false // inventory entries don't have a separate destination

    const stockEntryType = detectStockEntryType(voucher.voucherTypeName, hasSource, hasDestination)

    const items: StockEntryItem[] = []

    if (hasStockJournalEntries) {
        // Use explicit stock journal entries (have both source and destination)
        for (const entry of entries) {
            const baseItem = {
                item_code: sanitiseName(entry.stockItemName),
                item_name: entry.stockItemName,
                qty: absAmount(entry.billedQty || entry.actualQty) || 1,
                uom: entry.billedQtyUOM || entry.actualQtyUOM || 'Nos',
                basic_rate: absAmount(entry.rate),
                amount: absAmount(entry.amount),
                gst_hsn_code: entry.hsnCode || undefined,
            }

            if (entry.godownName && entry.destinationGodownName) {
                // Transfer: split into one issue item and one receipt item
                items.push({ ...baseItem, s_warehouse: resolveWarehouse(entry.godownName) })
                items.push({ ...baseItem, t_warehouse: resolveWarehouse(entry.destinationGodownName) })
            } else {
                const item: StockEntryItem = { ...baseItem }
                if (entry.godownName) {
                    item.s_warehouse = resolveWarehouse(entry.godownName)
                }
                if (entry.destinationGodownName) {
                    item.t_warehouse = resolveWarehouse(entry.destinationGodownName)
                }
                items.push(item)
            }
        }
    } else {
        // Use regular inventory entries
        for (const inv of voucher.inventoryEntries) {
            const item: StockEntryItem = {
                item_code: sanitiseName(inv.stockItemName),
                item_name: inv.stockItemName,
                qty: absAmount(inv.billedQty || inv.actualQty) || 1,
                uom: inv.billedQtyUOM || inv.actualQtyUOM || 'Nos',
                basic_rate: absAmount(inv.rate),
                amount: absAmount(inv.amount),
                gst_hsn_code: inv.hsnCode || undefined,
            }

            const godown = inv.godownName
            switch (stockEntryType) {
                case 'Material Receipt':
                case 'Material Transfer Entry':
                    // For receipts/transfers: godown is target
                    item.t_warehouse = resolveWarehouse(godown)
                    break
                case 'Material Issue':
                    // For issues: godown is source
                    item.s_warehouse = resolveWarehouse(godown)
                    break
            }

            // For transfers, set both source and destination to same warehouse
            // (real distinction comes from stock journal entries above)
            if (stockEntryType === 'Material Transfer Entry' && !item.s_warehouse) {
                item.s_warehouse = defaultWarehouse
            }

            items.push(item)
        }
    }

    const doc: ERPNextStockEntry = {
        doctype: 'Stock Entry',
        stock_entry_type: stockEntryType,
        posting_date: tallyDateToErp(voucher.date),
        company: config.erpnextCompany,
        from_warehouse: stockEntryType === 'Material Issue' || stockEntryType === 'Material Transfer Entry'
            ? defaultWarehouse
            : undefined,
        to_warehouse: stockEntryType === 'Material Receipt' || stockEntryType === 'Material Transfer Entry'
            ? defaultWarehouse
            : undefined,
        remarks: voucher.narration || undefined,
        items,
        custom_tally_guid: voucher.guid,
        custom_tally_voucher_number: voucher.voucherNumber,
        custom_sync_source: 'TALLYBRIDGE',
    }

    return { success: true, doc, warnings: [] }
}
