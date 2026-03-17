/**
 * ERPNext Stock Entry → Tally Stock Journal Voucher data.
 *
 * Each ERPNext stock entry item maps to ALLINVENTORYENTRIES.LIST in Tally.
 * Material Issue: items have s_warehouse (source) → ISDEEMEDPOSITIVE=No
 * Material Receipt: items have t_warehouse (destination) → ISDEEMEDPOSITIVE=Yes
 * Material Transfer: items have both → two entries per item (one out, one in)
 */
import type { ERPNextStockEntry, CompanyConfig } from '../../types'
import { erpDateToTally, roundInr } from '../utils'
import type { TallyVoucherInput, TallyLedgerEntryInput } from './sales'

export interface TallyStockVoucherInput extends TallyVoucherInput {
    stockJournalEntries: TallyStockJournalEntryInput[]
}

export interface TallyStockJournalEntryInput {
    stockItemName: string
    isDeemedPositive: boolean // true = receipt (into godown), false = issue (from godown)
    godownName: string
    actualQty: number
    billedQty: number
    billedQtyUOM: string
    rate: number
    amount: number
    hsnCode?: string
}

/** Reverse warehouse name → Tally godown name.
 *  Strips " - ABBR" suffix that ERPNext appends; falls back to "Main Location". */
function warehouseToGodown(warehouse: string, config: CompanyConfig): string {
    if (!warehouse) return 'Main Location'
    const abbr = config.erpnextAbbr ?? ''
    // Strip " - ABBR" suffix
    const stripped = warehouse.replace(new RegExp(`\\s*-\\s*${abbr}$`), '').trim()
    if (!stripped || stripped.toLowerCase() === 'stores') return 'Main Location'
    return stripped
}

export function buildStockVoucherXML(
    stockEntry: ERPNextStockEntry,
    config: CompanyConfig,
    action: 'CREATE' | 'ALTER' | 'CANCEL' = 'CREATE',
): TallyStockVoucherInput {
    const stockJournalEntries: TallyStockJournalEntryInput[] = []
    const ledgerEntries: TallyLedgerEntryInput[] = []

    let totalAmount = 0

    for (const item of stockEntry.items) {
        const qty = Math.abs(item.qty)
        const rate = item.basic_rate ?? 0
        const amount = roundInr(item.amount ?? qty * rate)
        totalAmount += amount

        if (
            stockEntry.stock_entry_type === 'Material Transfer Entry' ||
            stockEntry.stock_entry_type === 'Material Transfer'
        ) {
            // Transfer: one issue entry (from s_warehouse) + one receipt entry (into t_warehouse)
            if (item.s_warehouse) {
                stockJournalEntries.push({
                    stockItemName: item.item_code,
                    isDeemedPositive: false, // issue from source
                    godownName: warehouseToGodown(item.s_warehouse, config),
                    actualQty: qty,
                    billedQty: qty,
                    billedQtyUOM: item.uom,
                    rate,
                    amount: -amount,
                    hsnCode: item.gst_hsn_code,
                })
            }
            if (item.t_warehouse) {
                stockJournalEntries.push({
                    stockItemName: item.item_code,
                    isDeemedPositive: true, // receipt into destination
                    godownName: warehouseToGodown(item.t_warehouse, config),
                    actualQty: qty,
                    billedQty: qty,
                    billedQtyUOM: item.uom,
                    rate,
                    amount,
                    hsnCode: item.gst_hsn_code,
                })
            }
        } else if (stockEntry.stock_entry_type === 'Material Issue') {
            // Issue: only source godown, isDeemedPositive=false
            const godown = item.s_warehouse ? warehouseToGodown(item.s_warehouse, config) : 'Main Location'
            stockJournalEntries.push({
                stockItemName: item.item_code,
                isDeemedPositive: false,
                godownName: godown,
                actualQty: qty,
                billedQty: qty,
                billedQtyUOM: item.uom,
                rate,
                amount: -amount,
                hsnCode: item.gst_hsn_code,
            })
        } else {
            // Material Receipt: destination godown, isDeemedPositive=true
            const godown = item.t_warehouse ? warehouseToGodown(item.t_warehouse, config) : 'Main Location'
            stockJournalEntries.push({
                stockItemName: item.item_code,
                isDeemedPositive: true,
                godownName: godown,
                actualQty: qty,
                billedQty: qty,
                billedQtyUOM: item.uom,
                rate,
                amount,
                hsnCode: item.gst_hsn_code,
            })
        }
    }

    // Stock Journal in Tally requires balancing ALLLEDGERENTRIES.LIST entries
    // pointing to the Stock-in-Hand account to balance the stock movement.
    // For transfers, net ledger impact is zero; for issue/receipt, use the mapped account.
    const stockInHandAccount =
        reverseMapAccount(
            config.accountMappings['Stock In Hand'] ?? config.accountMappings['Closing Stock'] ?? '',
            config,
        ) || 'Stock In Hand'

    if (stockEntry.stock_entry_type === 'Material Issue') {
        // Credit stock-in-hand (reducing stock value)
        ledgerEntries.push({
            ledgerName: stockInHandAccount,
            isDeemedPositive: false,
            isPartyLedger: false,
            amount: -roundInr(totalAmount),
            billAllocations: [],
        })
    } else if (stockEntry.stock_entry_type === 'Material Receipt') {
        // Debit stock-in-hand (increasing stock value)
        ledgerEntries.push({
            ledgerName: stockInHandAccount,
            isDeemedPositive: true,
            isPartyLedger: false,
            amount: roundInr(totalAmount),
            billAllocations: [],
        })
    }
    // For transfers, ledger entries are zero-net — no ledger entry needed

    return {
        action,
        guid: stockEntry.custom_tally_guid ?? `ERP-${stockEntry.name}`,
        voucherType: 'Stock Journal',
        objView: 'Inventory Voucher View',
        date: erpDateToTally(stockEntry.posting_date),
        voucherNumber: stockEntry.name ?? '',
        partyLedgerName: '',
        narration: stockEntry.remarks,
        isInvoice: false,
        ledgerEntries,
        inventoryEntries: [],
        stockJournalEntries,
    }
}

function reverseMapAccount(erpAccount: string, config: CompanyConfig): string {
    for (const [tally, erp] of Object.entries(config.accountMappings)) {
        if (erp === erpAccount) return tally
    }
    return erpAccount
}
