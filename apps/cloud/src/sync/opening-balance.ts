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

    // Idempotency: check for existing JE (may be draft or submitted)
    const existingGuid = `opening-balance-${opts.companyId}`
    const existing = await erpClient.findByTallyGUID('Journal Entry', existingGuid)
    if (existing) {
        // Check docstatus — if already submitted, we're done
        const existingDoc = await erpClient.getDoc<{ docstatus?: number }>('Journal Entry', existing)
        if ((existingDoc.docstatus ?? 0) >= 1) {
            logger.info({ companyId: opts.companyId, erpName: existing }, 'Opening balance JE already submitted — skipping')
            return existing
        }
        // Draft exists — delete it so we can recreate with the latest filtering logic
        logger.info({ companyId: opts.companyId, erpName: existing }, 'Deleting stale draft opening balance JE to recreate')
        try {
            await erpClient.deleteDoc('Journal Entry', existing)
        } catch (delErr) {
            logger.warn({ erpName: existing, delErr }, 'Could not delete draft JE — will attempt to proceed anyway')
        }
    }

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

    // Auto-create any missing GL accounts in ERPNext before posting the JE.
    // ensureGLAccount takes base name (without "- ABBR") so strip the suffix first.
    const abbr = opts.erpnextAbbr ?? opts.erpnextCompany.split(' ').map((w) => w[0]).join('').toUpperCase().slice(0, 3)
    const abbrSuffix = ` - ${abbr}`
    const stripAbbr = (name: string) => name.endsWith(abbrSuffix) ? name.slice(0, -abbrSuffix.length) : name
    for (const acct of accounts) {
        try {
            await erpClient.ensureGLAccount(stripAbbr(acct.account), opts.erpnextCompany, abbr)
        } catch (_) {
            // best-effort — if it already exists ERPNext will return it; if it fails we'll see the error on JE creation
        }
    }

    // Fetch account metadata and filter/adjust each account:
    //   1. Skip Depreciation accounts — ERPNext requires voucher_type='Depreciation Entry' for them
    //   2. Skip P&L accounts (root_type Income/Expense) — Opening Entry only allows Balance Sheet accounts
    //   3. Add is_advance='No' for Payable/Receivable accounts without a party (avoids "check Is Advance" error)
    const DEPRECIATION_TYPES = new Set(['Accumulated Depreciation', 'Depreciation'])
    const PL_ROOT_TYPES = new Set(['Income', 'Expense'])
    const filteredAccounts: JournalAccount[] = []
    let filteredDebit = 0
    let filteredCredit = 0
    for (const acct of accounts) {
        try {
            const accountDoc = await erpClient.getDoc<{ account_type?: string; root_type?: string }>('Account', acct.account)
            if (accountDoc.account_type && DEPRECIATION_TYPES.has(accountDoc.account_type)) {
                warnings.push(`Skipping depreciation account: ${acct.account} (account_type=${accountDoc.account_type})`)
                continue
            }
            if (accountDoc.root_type && PL_ROOT_TYPES.has(accountDoc.root_type)) {
                warnings.push(`Skipping P&L account: ${acct.account} (root_type=${accountDoc.root_type}) — not valid in Opening Entry`)
                continue
            }
            // Payable/Receivable without a party needs is_advance='No' to suppress ERPNext warning
            if (
                (accountDoc.account_type === 'Payable' || accountDoc.account_type === 'Receivable') &&
                !acct.party
            ) {
                acct.is_advance = 'No'
            }
        } catch (_) {
            // If we can't fetch the account type, include it and let ERPNext validate
        }
        filteredAccounts.push(acct)
        filteredDebit += acct.debit_in_account_currency
        filteredCredit += acct.credit_in_account_currency
    }
    // Replace accounts list with filtered version
    accounts.length = 0
    accounts.push(...filteredAccounts)
    totalDebit = filteredDebit
    totalCredit = filteredCredit

    // Balance the entry with Temporary Opening account if dr != cr.
    // Use the mapped "Suspense/Temporary Opening" account from mappings if available,
    // otherwise fall back to a hardcoded name.
    const diff = Math.round((totalDebit - totalCredit) * 100) / 100
    if (Math.abs(diff) > 0.01) {
        const tempAccount =
            opts.accountMappings['Temporary Opening'] ??
            opts.accountMappings['SUSPENCES ACCOUNT'] ??
            opts.accountMappings['Suspense Account'] ??
            `Temporary Opening - ${abbr}`
        try {
            await erpClient.ensureGLAccount(stripAbbr(tempAccount), opts.erpnextCompany, abbr)
        } catch (_) { /* best-effort */ }
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

    let jeName: string
    try {
        const created = await erpClient.createDoc<{ name: string }>(
            'Journal Entry',
            doc as unknown as Record<string, unknown>,
        )
        jeName = created.name
        logger.info(
            { companyId: opts.companyId, erpName: jeName, entries: accounts.length, warnings },
            'Opening balance Journal Entry created',
        )
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (/tally guid must be unique/i.test(msg)) {
            // A draft JE was created in a previous attempt but failed to submit — find it
            const found = await erpClient.findByTallyGUID('Journal Entry', existingGuid)
            if (found) {
                jeName = found
                logger.info({ companyId: opts.companyId, erpName: jeName }, 'Found existing draft opening balance JE — will try to submit')
            } else {
                logger.error({ err, companyId: opts.companyId }, 'Failed to create opening balance Journal Entry')
                throw err
            }
        } else {
            logger.error({ err, companyId: opts.companyId }, 'Failed to create opening balance Journal Entry')
            throw err
        }
    }

    try {
        await erpClient.submitDoc('Journal Entry', jeName)
        logger.info({ erpName: jeName }, 'Opening balance Journal Entry submitted')
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (/already submitted/i.test(msg)) {
            logger.info({ erpName: jeName }, 'Opening balance JE was already submitted — returning')
        } else {
            logger.error({ err, companyId: opts.companyId }, 'Failed to submit opening balance Journal Entry')
            throw err
        }
    }

    return jeName
}
