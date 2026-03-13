/**
 * Router: maps Tally voucher type → correct transform function.
 */
import type { TallyVoucher, CompanyConfig, ERPNextDocument, TransformResult } from '../../types'
import { transformSales } from './sales'
import { transformPurchase } from './purchase'
import { transformPayment } from './payment'
import { transformJournal } from './journal'

export function transformVoucher(
    voucher: TallyVoucher,
    config: CompanyConfig
): TransformResult<ERPNextDocument> {
    const vt = voucher.voucherTypeName.toLowerCase()

    // Use company's voucherTypeMapping first
    const mapping = config.voucherTypeMappings[voucher.voucherTypeName]
    if (mapping) {
        switch (mapping.erpnextDoctype) {
            case 'Sales Invoice': return transformSales(voucher, config) as TransformResult<ERPNextDocument>
            case 'Purchase Invoice': return transformPurchase(voucher, config) as TransformResult<ERPNextDocument>
            case 'Payment Entry': return transformPayment(voucher, config) as TransformResult<ERPNextDocument>
            case 'Journal Entry': return transformJournal(voucher, config) as TransformResult<ERPNextDocument>
        }
    }

    // Default mapping by standard type name
    if (vt === 'sales' || vt.includes('sales') || vt.includes('credit note'))
        return transformSales(voucher, config) as TransformResult<ERPNextDocument>
    if (vt === 'purchase' || vt.includes('purchase') || vt.includes('debit note'))
        return transformPurchase(voucher, config) as TransformResult<ERPNextDocument>
    if (vt === 'payment' || vt.includes('payment'))
        return transformPayment(voucher, config) as TransformResult<ERPNextDocument>
    if (vt === 'receipt' || vt.includes('receipt'))
        return transformPayment(voucher, config) as TransformResult<ERPNextDocument>
    if (vt === 'journal' || vt === 'contra')
        return transformJournal(voucher, config) as TransformResult<ERPNextDocument>

    return {
        success: false,
        error: {
            code: 'TRANSFORM_FAILED',
            message: `No transform found for voucher type "${voucher.voucherTypeName}". Add it to voucherTypeMappings in config.`,
        },
    }
}

export { transformSales, transformPurchase, transformPayment, transformJournal }
