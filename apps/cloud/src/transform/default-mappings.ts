/**
 * Default account mappings for a new company.
 *
 * Given the ERPNext company abbreviation (abbr), returns:
 *  - gstLedgerMappings: the 6 standard GST account keys → ERPNext account names
 *  - voucherTypeMappings: standard Tally voucher type names → ERPNext doctypes
 *  - groupDefaultMappings: Tally ledger group → ERPNext account name pattern
 *
 * These defaults cover ~80% of a new company's sync needs without manual config.
 * Users only need to map specific expense/income ledgers beyond these.
 */

export interface DefaultMappings {
    gstLedgerMappings: Record<string, string>
    voucherTypeMappings: Record<string, string>
    groupDefaultMappings: Record<string, string>
}

/**
 * Build default mappings for a company given its ERPNext abbreviation.
 * ERPNext India COA uses standard account names with " - ABBR" suffix.
 */
export function buildDefaultMappings(abbr: string): DefaultMappings {
    const s = abbr ? ` - ${abbr}` : ''

    const gstLedgerMappings: Record<string, string> = {
        output_cgst: `Output Tax CGST${s}`,
        output_sgst: `Output Tax SGST${s}`,
        output_igst: `Output Tax IGST${s}`,
        input_cgst: `Input Tax CGST${s}`,
        input_sgst: `Input Tax SGST${s}`,
        input_igst: `Input Tax IGST${s}`,
    }

    // Standard Tally voucher type name → ERPNext doctype
    const voucherTypeMappings: Record<string, string> = {
        Sales: 'Sales Invoice',
        Purchase: 'Purchase Invoice',
        Payment: 'Payment Entry',
        Receipt: 'Payment Entry',
        Journal: 'Journal Entry',
        Contra: 'Journal Entry',
        'Credit Note': 'Sales Invoice',
        'Debit Note': 'Purchase Invoice',
        'Stock Journal': 'Stock Entry',
        'Delivery Note': 'Delivery Note',
        'Purchase Order': 'Purchase Order',
        'Sales Order': 'Sales Order',
    }

    // Tally ledger group → ERPNext account name
    // Used by account-resolver when a ledger has no manual mapping but its group is known.
    const groupDefaultMappings: Record<string, string> = {
        // Income
        'Sales Accounts': `Sales${s}`,
        'Direct Income': `Sales${s}`,
        'Indirect Income': `Sales${s}`,
        // COGS / Expenses
        'Purchase Accounts': `Cost of Goods Sold${s}`,
        'Direct Expenses': `Cost of Goods Sold${s}`,
        'Indirect Expenses': `Indirect Expenses${s}`,
        // Balance Sheet — Assets
        'Cash-in-Hand': `Cash${s}`,
        'Bank Accounts': `Bank Accounts${s}`,
        'Loans & Advances (Asset)': `Loans and Advances (Asset)${s}`,
        // Balance Sheet — Liabilities
        'Duties & Taxes': `Duties and Taxes${s}`,
        'Current Liabilities': `Current Liabilities${s}`,
        'Loans & Advances (Liability)': `Loans and Advances (Liability)${s}`,
        // Capital & Equity
        'Capital Account': `Capital Account${s}`,
        'Reserves & Surplus': `Reserves and Surplus${s}`,
    }

    return { gstLedgerMappings, voucherTypeMappings, groupDefaultMappings }
}

/**
 * Tally group → root type classification.
 * Used by the Configuration UI to place each ledger in the right section.
 */
export const TALLY_GROUP_ROOT_TYPE: Record<string, 'Asset' | 'Liability' | 'Income' | 'Expense' | 'Equity'> = {
    // Assets
    'Sundry Debtors': 'Asset',
    'Bank Accounts': 'Asset',
    'Cash-in-Hand': 'Asset',
    'Loans & Advances (Asset)': 'Asset',
    'Fixed Assets': 'Asset',
    'Current Assets': 'Asset',
    'Stock-in-Hand': 'Asset',
    Investments: 'Asset',
    'Misc. Expenses (Asset)': 'Asset',

    // Liabilities
    'Sundry Creditors': 'Liability',
    'Duties & Taxes': 'Liability',
    'Current Liabilities': 'Liability',
    'Loans & Advances (Liability)': 'Liability',
    Provisions: 'Liability',
    'Bank OD Accounts': 'Liability',

    // Income
    'Sales Accounts': 'Income',
    'Direct Income': 'Income',
    'Indirect Income': 'Income',

    // Expenses
    'Purchase Accounts': 'Expense',
    'Direct Expenses': 'Expense',
    'Indirect Expenses': 'Expense',

    // Equity
    'Capital Account': 'Equity',
    'Reserves & Surplus': 'Equity',
    'Retained Earnings': 'Equity',
}

/**
 * Returns the root type for a given Tally ledger group.
 * Falls back to 'Expense' for unknown groups (safest default for unmapped accounts).
 */
export function groupRootType(group: string): 'Asset' | 'Liability' | 'Income' | 'Expense' | 'Equity' {
    return TALLY_GROUP_ROOT_TYPE[group] ?? 'Expense'
}

/**
 * Tally group → ERPNext parent account (group account) for creating leaf accounts.
 * When auto-creating a ledger as an ERPNext account, the parent must be a group account.
 * This maps Tally groups to the correct ERPNext group account name.
 *
 * Note: `&` in Tally becomes `and` in ERPNext account names.
 */
export function tallyGroupToERPNextParent(tallyGroup: string, abbr: string): string {
    const s = abbr ? ` - ${abbr}` : ''
    const map: Record<string, string> = {
        // Income
        'Sales Accounts': `Direct Income${s}`,
        'Direct Income': `Direct Income${s}`,
        'Indirect Income': `Indirect Income${s}`,
        // Expenses
        'Purchase Accounts': `Direct Expenses${s}`,
        'Direct Expenses': `Direct Expenses${s}`,
        'Indirect Expenses': `Indirect Expenses${s}`,
        // Assets
        'Bank Accounts': `Bank Accounts${s}`,
        'Cash-in-Hand': `Cash In Hand${s}`,
        'Fixed Assets': `Fixed Assets${s}`,
        'Current Assets': `Current Assets${s}`,
        'Stock-in-Hand': `Stock Assets${s}`,
        Investments: `Investments${s}`,
        'Loans & Advances (Asset)': `Loans and Advances (Assets)${s}`,
        'Misc. Expenses (Asset)': `Current Assets${s}`,
        // Liabilities
        'Duties & Taxes': `Duties and Taxes${s}`,
        'Current Liabilities': `Current Liabilities${s}`,
        'Loans & Advances (Liability)': `Loans (Liabilities)${s}`,
        Provisions: `Current Liabilities${s}`,
        'Bank OD Accounts': `Loans (Liabilities)${s}`,
        'Secured Loans': `Loans (Liabilities)${s}`,
        'Unsecured Loans': `Loans (Liabilities)${s}`,
        // Equity
        'Capital Account': `Capital Account${s}`,
        'Reserves & Surplus': `Reserves and Surplus${s}`,
        'Retained Earnings': `Reserves and Surplus${s}`,
    }
    return map[tallyGroup] ?? `Indirect Expenses${s}`
}

/**
 * Infer ERPNext account_type from Tally ledger type and group.
 */
export function inferAccountType(ledgerType: string, tallyGroup: string): string | undefined {
    if (ledgerType === 'Bank') return 'Bank'
    if (ledgerType === 'Cash') return 'Cash'
    if (ledgerType === 'Tax') return 'Tax'
    if (ledgerType === 'Income') return 'Income Account'
    if (tallyGroup === 'Fixed Assets') return 'Fixed Asset'
    if (tallyGroup === 'Stock-in-Hand') return 'Stock'
    if (tallyGroup === 'Investments') return undefined
    return undefined
}
