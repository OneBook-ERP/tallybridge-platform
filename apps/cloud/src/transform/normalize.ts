/**
 * Normalize a voucher record from Go's PascalCase JSON to the camelCase
 * expected by the TypeScript TallyVoucher interface.
 *
 * Go's encoding/json uses struct field names when json tags are missing
 * or when the binary was compiled before tags were added. This handles both.
 */

export function normalizeVoucher(raw: Record<string, unknown>): Record<string, unknown> {
    // If already camelCase (has 'guid'), return as-is
    if ('guid' in raw && 'voucherTypeName' in raw) return raw

    // Map PascalCase → camelCase for top-level voucher fields
    const keyMap: Record<string, string> = {
        GUID: 'guid',
        Date: 'date',
        AlteredOn: 'alteredOn',
        VoucherTypeName: 'voucherTypeName',
        VoucherNumber: 'voucherNumber',
        ReferenceNumber: 'referenceNumber',
        ReferenceDate: 'referenceDate',
        PartyLedgerName: 'partyLedgerName',
        IsInvoice: 'isInvoice',
        IsOptional: 'isOptional',
        IsCancelled: 'isCancelled',
        Narration: 'narration',
        ForeignCurrency: 'foreignCurrency',
        ForeignAmount: 'foreignAmount',
        PlaceOfSupply: 'placeOfSupply',
        PartyGSTIN: 'partyGSTIN',
        IsRCMApplicable: 'isRCMApplicable',
        EWayBillNumber: 'eWayBillNumber',
        EWAYBILLNO: 'eWayBillNumber',
        IRNNO: 'irnNo',
        IRN: 'irn',
        IRNACKNO: 'irnAckNo',
        IrnAckNo: 'irnAckNo',
        IrnNo: 'irn',
        FOREIGNCURRENCYNAME: 'foreignCurrency',
        FOREIGNCURRENCYAMOUNT: 'foreignAmount',
        LedgerEntries: 'ledgerEntries',
        InventoryEntries: 'inventoryEntries',
    }
    const ledgerKeyMap: Record<string, string> = {
        LedgerName: 'ledgerName',
        IsDeemedPositive: 'isDeemedPositive',
        IsPartyLedger: 'isPartyLedger',
        Amount: 'amount',
        BillAllocations: 'billAllocations',
        BankAllocations: 'bankAllocations',
    }
    const billKeyMap: Record<string, string> = {
        Name: 'name',
        BillType: 'billType',
        Amount: 'amount',
        DueDate: 'dueDate',
    }
    const bankKeyMap: Record<string, string> = {
        InstNumber: 'instNumber',
        UniqueReferenceNumber: 'uniqueReferenceNumber',
        TransactionType: 'transactionType',
    }
    const invKeyMap: Record<string, string> = {
        StockItemName: 'stockItemName',
        Rate: 'rate',
        RateUOM: 'rateUOM',
        Amount: 'amount',
        ActualQty: 'actualQty',
        ActualQtyUOM: 'actualQtyUOM',
        BilledQty: 'billedQty',
        BilledQtyUOM: 'billedQtyUOM',
        HSNCode: 'hsnCode',
        GSTOvrdnRate: 'gstOvrdnRate',
        GodownName: 'godownName',
        ExpiryDate: 'expiryDate',
        AccountLedgerName: 'accountLedgerName',
    }

    function remap(obj: Record<string, unknown>, map: Record<string, string>): Record<string, unknown> {
        const out: Record<string, unknown> = {}
        for (const [k, v] of Object.entries(obj)) {
            out[map[k] ?? k] = v
        }
        return out
    }

    const v = remap(raw, keyMap)

    // Normalize nested ledger entries
    if (Array.isArray(v.ledgerEntries)) {
        v.ledgerEntries = (v.ledgerEntries as Record<string, unknown>[]).map((le) => {
            const nle = remap(le, ledgerKeyMap)
            if (Array.isArray(nle.billAllocations)) {
                nle.billAllocations = (nle.billAllocations as Record<string, unknown>[]).map((b) =>
                    remap(b, billKeyMap),
                )
            }
            if (Array.isArray(nle.bankAllocations)) {
                nle.bankAllocations = (nle.bankAllocations as Record<string, unknown>[]).map((b) =>
                    remap(b, bankKeyMap),
                )
            }
            return nle
        })
    }

    // Normalize nested inventory entries
    if (Array.isArray(v.inventoryEntries)) {
        v.inventoryEntries = (v.inventoryEntries as Record<string, unknown>[]).map((ie) => remap(ie, invKeyMap))
    }

    return v
}
