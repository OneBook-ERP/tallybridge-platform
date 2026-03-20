/**
 * Router: maps Tally voucher type → correct transform function.
 */
import type { TallyVoucher, CompanyConfig, ERPNextDocument, TransformResult } from '../../types'
import { transformSales } from './sales'
import { transformPurchase } from './purchase'
import { transformPayment } from './payment'
import { transformJournal } from './journal'
import { transformStock } from './stock'

// Tally voucher types that are HR/payroll/manufacturing — not accounting entries.
// These are silently ignored (no exception recorded) when no custom mapping is configured.
const IGNORED_VOUCHER_TYPES = new Set([
    'attendance',
    'payroll',
    'salary',
    'salary slip',
    'leave application',
    'leave encashment',
    'manufacturing journal',
    'rejection note',
    'memo',
    'order',
    'note',
    'reversing journal',
])

export function transformVoucher(voucher: TallyVoucher, config: CompanyConfig): TransformResult<ERPNextDocument> {
    const vt = voucher.voucherTypeName.toLowerCase()

    // Use company's voucherTypeMapping first
    const rawMapping = config.voucherTypeMappings[voucher.voucherTypeName]
    // Handle both { erpnextDoctype: "..." } objects and plain "Sales Invoice" strings
    const mapping = rawMapping
        ? typeof rawMapping === 'string'
            ? { erpnextDoctype: rawMapping as typeof rawMapping & string }
            : rawMapping
        : undefined
    if (mapping) {
        // Skip: user explicitly configured this voucher type to be skipped
        if (mapping.erpnextDoctype === 'skip') {
            return {
                success: false,
                error: {
                    code: 'IGNORED_VOUCHER',
                    message: `Voucher type "${voucher.voucherTypeName}" is configured to skip.`,
                },
            }
        }
        switch (mapping.erpnextDoctype) {
            case 'Sales Invoice':
                return transformSales(voucher, config) as TransformResult<ERPNextDocument>
            case 'Purchase Invoice':
                return transformPurchase(voucher, config) as TransformResult<ERPNextDocument>
            case 'Payment Entry':
                return transformPayment(voucher, config) as TransformResult<ERPNextDocument>
            case 'Journal Entry':
                return transformJournal(voucher, config) as TransformResult<ERPNextDocument>
            case 'Stock Entry':
                return transformStock(voucher, config) as TransformResult<ERPNextDocument>
        }
    }

    // Default mapping by standard type name
    if (vt === 'sales' || vt.includes('sales') || vt.includes('credit note'))
        return transformSales(voucher, config) as TransformResult<ERPNextDocument>
    if (vt === 'purchase' || vt.includes('purchase') || vt.includes('debit note'))
        return transformPurchase(voucher, config) as TransformResult<ERPNextDocument>
    if (vt === 'payment' || vt.includes('payment')) {
        const r = transformPayment(voucher, config)
        if (!r.success && r.error.code === 'FALLBACK_TO_JOURNAL')
            return transformJournal(voucher, config) as TransformResult<ERPNextDocument>
        return r as TransformResult<ERPNextDocument>
    }
    if (vt === 'receipt' || vt.includes('receipt')) {
        const r = transformPayment(voucher, config)
        if (!r.success && r.error.code === 'FALLBACK_TO_JOURNAL')
            return transformJournal(voucher, config) as TransformResult<ERPNextDocument>
        return r as TransformResult<ERPNextDocument>
    }
    if (vt === 'journal' || vt === 'contra')
        return transformJournal(voucher, config) as TransformResult<ERPNextDocument>

    // Stock Journal / Physical Stock / Material In / Material Out → Stock Entry
    if (
        vt === 'stock journal' ||
        vt === 'physical stock' ||
        vt === 'material in' ||
        vt === 'material out' ||
        vt.includes('stock journal')
    )
        return transformStock(voucher, config) as TransformResult<ERPNextDocument>

    // Check against known non-accounting types (HR, manufacturing, etc.)
    if (IGNORED_VOUCHER_TYPES.has(vt)) {
        return {
            success: false,
            error: {
                code: 'IGNORED_VOUCHER',
                message: `Voucher type "${voucher.voucherTypeName}" is not an accounting entry — skipped.`,
            },
        }
    }

    return {
        success: false,
        error: {
            code: 'TRANSFORM_FAILED',
            message: `No transform found for voucher type "${voucher.voucherTypeName}". Add it to voucherTypeMappings in config.`,
        },
    }
}

export { transformSales, transformPurchase, transformPayment, transformJournal, transformStock }
