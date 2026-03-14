/**
 * Opening Balance Generator — creates an Opening Entry Journal in ERPNext
 * from Tally ledger master opening balances.
 *
 * Reads ledger_masters table (populated by master data sync) and generates
 * a single Journal Entry with voucher_type = 'Opening Entry' and is_opening = 'Yes'.
 */
import { sql } from '../db/db'
import { ERPNextClient, erpClient as defaultErpClient } from '../erpnext/client'
import { logger } from '../lib/logger'
import type { JournalAccount } from '../types'

interface OpeningBalanceRow {
    tally_name: string
    tally_group: string
    opening_balance: number
    ledger_type: string
    is_party_ledger: boolean
}

interface OpeningBalanceOptions {
    companyId: string
    erpnextCompany: string
    erpnextAbbr?: string
    postingDate: string // YYYY-MM-DD — typically FY start date
    accountMappings: Record<string, string>
    costCenter?: string
    companyGstin?: string
    erpnextUrl?: string
    erpnextApiKey?: string
    erpnextApiSecret?: string
}

/**
 * Generate and post an Opening Entry Journal in ERPNext from Tally opening balances.
 * Returns the ERPNext Journal Entry name, or null if no balances found.
 */
export async function generateOpeningBalance(opts: OpeningBalanceOptions): Promise<string | null> {
    const erpClient =
        opts.erpnextUrl && opts.erpnextApiKey && opts.erpnextApiSecret
            ? new ERPNextClient({
                  baseUrl: opts.erpnextUrl,
                  apiKey: opts.erpnextApiKey,
                  apiSecret: opts.erpnextApiSecret,
              })
            : defaultErpClient

    // Fetch all ledgers with non-zero opening balance
    const rows = await sql<OpeningBalanceRow[]>`
        SELECT tally_name, tally_group, opening_balance, ledger_type, is_party_ledger
        FROM ledger_masters
        WHERE company_id = ${opts.companyId}
          AND opening_balance != 0
        ORDER BY tally_name
    `

    if (rows.length === 0) {
        logger.info({ companyId: opts.companyId }, 'No opening balances found in ledger_masters')
        return null
    }

    const accounts: JournalAccount[] = []
    let totalDebit = 0
    let totalCredit = 0
    const warnings: string[] = []

    for (const row of rows) {
        // Resolve account name from mappings
        const erpAccount = opts.accountMappings[row.tally_name]
        if (!erpAccount) {
            warnings.push(`Skipping unmapped ledger: ${row.tally_name} (₹${row.opening_balance})`)
            continue
        }

        // Tally convention: positive = debit, negative = credit
        const amt = Math.abs(row.opening_balance)
        const isDebit = row.opening_balance > 0
        const dr = isDebit ? amt : 0
        const cr = isDebit ? 0 : amt

        totalDebit += dr
        totalCredit += cr

        const jAccount: JournalAccount = {
            account: erpAccount,
            debit_in_account_currency: Math.round(dr * 100) / 100,
            credit_in_account_currency: Math.round(cr * 100) / 100,
            cost_center: opts.costCenter,
        }

        // Attach party details for receivable/payable accounts
        if (row.is_party_ledger || row.ledger_type === 'Customer' || row.ledger_type === 'Supplier') {
            jAccount.party_type = row.ledger_type === 'Customer' ? 'Customer' : 'Supplier'
            jAccount.party = row.tally_name
        }

        accounts.push(jAccount)
    }

    if (accounts.length === 0) {
        logger.warn({ companyId: opts.companyId, warnings }, 'All opening balances unmapped — nothing to post')
        return null
    }

    // Balance the entry with Temporary Opening account if dr != cr
    const diff = Math.round((totalDebit - totalCredit) * 100) / 100
    if (Math.abs(diff) > 0.01) {
        const suffix =
            opts.erpnextAbbr ??
            opts.erpnextCompany
                .split(' ')
                .map((w) => w[0])
                .join('')
                .toUpperCase()
                .slice(0, 3)
        const tempAccount = `Temporary Opening - ${suffix}`
        accounts.push({
            account: tempAccount,
            debit_in_account_currency: diff < 0 ? Math.abs(diff) : 0,
            credit_in_account_currency: diff > 0 ? diff : 0,
        })
        if (diff > 0) totalCredit += diff
        else totalDebit += Math.abs(diff)
    }

    const doc = {
        doctype: 'Journal Entry',
        voucher_type: 'Opening Entry',
        posting_date: opts.postingDate,
        company: opts.erpnextCompany,
        is_opening: 'Yes',
        user_remark: 'Opening balances imported from Tally via TallyBridge',
        accounts,
        total_debit: Math.round(totalDebit * 100) / 100,
        total_credit: Math.round(totalCredit * 100) / 100,
        company_gstin: opts.companyGstin || undefined,
        custom_tally_guid: `opening-balance-${opts.companyId}`,
        custom_tally_voucher_number: 'Opening Balance',
        custom_sync_source: 'TALLYBRIDGE',
    }

    try {
        const created = await erpClient.createDoc<{ name: string }>(
            'Journal Entry',
            doc as unknown as Record<string, unknown>,
        )
        logger.info(
            { companyId: opts.companyId, erpName: created.name, entries: accounts.length, warnings },
            'Opening balance Journal Entry created',
        )

        // Submit the entry
        await erpClient.submitDoc('Journal Entry', created.name)
        logger.info({ erpName: created.name }, 'Opening balance Journal Entry submitted')

        return created.name
    } catch (err) {
        logger.error({ err, companyId: opts.companyId }, 'Failed to create opening balance Journal Entry')
        throw err
    }
}
