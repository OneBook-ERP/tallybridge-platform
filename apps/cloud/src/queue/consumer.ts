/**
 * Step 10 (updated) — BullMQ workers, now wired to the sync engine.
 */
import { Worker, type Job } from 'bullmq'
import { redisOpts, type SyncJobData, type TallyWriteJobData, type SyncJobName, type TallyWriteJobName } from './queues'
import { processTallyVoucher } from '../sync/engine'
import { normalizeVoucher } from '../transform/normalize'
import { broadcaster } from '../realtime/broadcaster'
import { sql } from '../db/db'
import { logger } from '../lib/logger'
import type { TallyVoucher, CompanyConfig } from '../types'

// Extended config carries per-company ERP credentials for the sync engine.
export interface CompanyConfigWithCreds extends CompanyConfig {
    erpnextUrl: string
    erpnextApiKey: string
    erpnextApiSecret: string
}

// ── Helper: load config for a company ─────────────────────────────────────────
async function loadConfig(companyId: string): Promise<CompanyConfigWithCreds | null> {
    const [row] = await sql<
        {
            account_mappings: Record<string, string>
            gst_ledger_mappings: Record<string, string>
            voucher_type_mappings: Record<string, unknown>
            conflict_strategy: { default: string; perDoctype?: Record<string, string> }
            sync_direction_rules: Record<string, string>
        }[]
    >`
    SELECT account_mappings, gst_ledger_mappings, voucher_type_mappings,
           conflict_strategy, sync_direction_rules
    FROM config_profiles WHERE company_id = ${companyId}
  `
    if (!row) return null

    const [company] = await sql<
        {
            erpnext_company: string
            erpnext_abbr: string | null
            erpnext_url: string
            erpnext_api_key: string
            erpnext_api_secret: string
        }[]
    >`
    SELECT erpnext_company, erpnext_abbr, erpnext_url, erpnext_api_key, erpnext_api_secret
    FROM companies WHERE id = ${companyId}
  `

    return {
        companyId,
        erpnextCompany: company?.erpnext_company ?? '',
        erpnextAbbr: company?.erpnext_abbr ?? undefined,
        erpnextUrl: company?.erpnext_url ?? '',
        erpnextApiKey: company?.erpnext_api_key ?? '',
        erpnextApiSecret: company?.erpnext_api_secret ?? '',
        currency: 'INR',
        costCenter: `Main - ${company?.erpnext_abbr ?? 'CPT'}`,
        companyGstin: '33AABCZ2616B1ZV',
        defaultState: 'Tamil Nadu',
        accountMappings: row.account_mappings ?? {},
        gstLedgerMappings: {
            output_cgst: row.gst_ledger_mappings?.output_cgst ?? '',
            output_sgst: row.gst_ledger_mappings?.output_sgst ?? '',
            output_igst: row.gst_ledger_mappings?.output_igst ?? '',
            input_cgst: row.gst_ledger_mappings?.input_cgst ?? '',
            input_sgst: row.gst_ledger_mappings?.input_sgst ?? '',
            input_igst: row.gst_ledger_mappings?.input_igst ?? '',
        },
        voucherTypeMappings: (row.voucher_type_mappings ?? {}) as CompanyConfig['voucherTypeMappings'],
        conflictStrategy: (row.conflict_strategy as CompanyConfig['conflictStrategy']) ?? { default: 'TALLY_WINS' },
        syncDirection: (row.sync_direction_rules ?? {}) as CompanyConfig['syncDirection'],
    }
}

// ── Worker: sync-jobs (Tally → ERPNext) ───────────────────────────────────────

export function startSyncWorker(): Worker<SyncJobData, void, SyncJobName> {
    const worker = new Worker<SyncJobData, void, SyncJobName>(
        'sync-jobs',
        async (job: Job<SyncJobData, void, SyncJobName>) => {
            const { companyId, recordType, records } = job.data

            const config = await loadConfig(companyId)
            if (!config) {
                logger.error({ companyId }, 'No config profile found — skipping batch')
                return
            }

            if (recordType === 'ledger') {
                await processMasterData(companyId, 'ledger', records)
                return
            }
            if (recordType === 'stockItem') {
                await processMasterData(companyId, 'stockItem', records)
                return
            }

            let synced = 0,
                errored = 0,
                skipped = 0

            for (const raw of records) {
                const normalized = normalizeVoucher(raw as Record<string, unknown>)
                const voucher = normalized as unknown as TallyVoucher
                const result = await processTallyVoucher(voucher, config)
                if (result.status === 'synced') synced++
                if (result.status === 'error') {
                    errored++
                    logger.error({ guid: voucher.guid, error: result.error }, 'Voucher sync error')
                }
                if (result.status === 'skipped') skipped++
            }

            broadcaster.emit(companyId, 'sync:progress', {
                companyId,
                direction: 'TALLY_TO_ERP',
                count: records.length,
                synced,
                errored,
                skipped,
                queueDepth: 0,
            })

            logger.info({ companyId, synced, errored, skipped }, 'Sync batch complete')
        },
        { connection: redisOpts, concurrency: 5 },
    )

    worker.on('completed', (job) => logger.info({ jobId: job.id }, 'sync-jobs completed'))
    worker.on('failed', (job, err) => logger.error({ jobId: job?.id, err }, 'sync-jobs failed'))
    return worker
}

// ── Helper: process master data (ledgers + stock items) ──────────────────────
async function processMasterData(
    companyId: string,
    type: 'ledger' | 'stockItem',
    records: Record<string, unknown>[],
): Promise<void> {
    let upserted = 0

    for (const raw of records) {
        try {
            if (type === 'ledger') {
                const name = (raw.Name ?? raw.name ?? raw.NAME ?? '') as string
                if (!name) continue

                const parent = (raw.Parent ?? raw.parent ?? raw.PARENT ?? '') as string
                const group = (raw.Group ?? raw.group ?? raw.GROUP ?? '') as string
                const gstin = (raw.GSTIN ?? raw.Gstin ?? raw.gstin ?? '') as string
                const isParty = (raw.IsPartyLedger ?? raw.isPartyLedger ?? raw.ISPARTYLEDGER ?? false) as boolean
                const openBal =
                    parseFloat(String(raw.OpeningBalance ?? raw.openingBalance ?? raw.OPENINGBALANCE ?? 0)) || 0

                // Classify ledger type from Tally group hierarchy
                const ledgerType = classifyLedger(group, parent)

                await sql`
                    INSERT INTO ledger_masters (company_id, tally_name, tally_parent, tally_group, opening_balance, gstin, is_party_ledger, ledger_type, raw_data, synced_at)
                    VALUES (${companyId}, ${name}, ${parent}, ${group}, ${openBal}, ${gstin || null}, ${isParty}, ${ledgerType}, ${raw}, now())
                    ON CONFLICT (company_id, tally_name)
                    DO UPDATE SET tally_parent = EXCLUDED.tally_parent, tally_group = EXCLUDED.tally_group,
                                  opening_balance = EXCLUDED.opening_balance, gstin = EXCLUDED.gstin,
                                  is_party_ledger = EXCLUDED.is_party_ledger, ledger_type = EXCLUDED.ledger_type,
                                  raw_data = EXCLUDED.raw_data, synced_at = now()
                `
                upserted++
            } else {
                const name = (raw.Name ?? raw.name ?? raw.NAME ?? '') as string
                if (!name) continue

                const parent = (raw.Parent ?? raw.parent ?? raw.PARENT ?? '') as string
                const uom = (raw.BaseUnits ?? raw.baseUnits ?? raw.BASEUNITS ?? raw.UOM ?? raw.uom ?? '') as string
                const hsn = (raw.HSNCode ?? raw.hsnCode ?? raw.HSNCODE ?? '') as string
                const openQty = parseFloat(String(raw.OpeningBalance ?? raw.openingBalance ?? raw.OpeningQty ?? 0)) || 0
                const openVal = parseFloat(String(raw.OpeningValue ?? raw.openingValue ?? 0)) || 0

                await sql`
                    INSERT INTO stock_item_masters (company_id, tally_name, tally_parent, uom, hsn_code, opening_qty, opening_value, raw_data, synced_at)
                    VALUES (${companyId}, ${name}, ${parent}, ${uom || null}, ${hsn || null}, ${openQty}, ${openVal}, ${raw}, now())
                    ON CONFLICT (company_id, tally_name)
                    DO UPDATE SET tally_parent = EXCLUDED.tally_parent, uom = EXCLUDED.uom,
                                  hsn_code = EXCLUDED.hsn_code, opening_qty = EXCLUDED.opening_qty,
                                  opening_value = EXCLUDED.opening_value, raw_data = EXCLUDED.raw_data, synced_at = now()
                `
                upserted++
            }
        } catch (err) {
            logger.warn({ type, name: raw.Name ?? raw.name, err }, 'Master data upsert failed')
        }
    }

    logger.info({ companyId, type, upserted, total: records.length }, 'Master data batch processed')
}

// Classify a Tally ledger into a broad type based on its group hierarchy
function classifyLedger(group: string, parent: string): string {
    const g = (group || parent || '').toLowerCase()
    if (g.includes('sundry debtor') || g.includes('trade receivable')) return 'Customer'
    if (g.includes('sundry creditor') || g.includes('trade payable')) return 'Supplier'
    if (g.includes('bank') || g.includes('cash')) return 'Bank'
    if (g.includes('duties') || g.includes('tax')) return 'Tax'
    if (g.includes('direct expense') || g.includes('indirect expense') || g.includes('expense')) return 'Expense'
    if (
        g.includes('direct income') ||
        g.includes('indirect income') ||
        g.includes('income') ||
        g.includes('revenue') ||
        g.includes('sales')
    )
        return 'Income'
    if (g.includes('fixed asset')) return 'Asset'
    if (g.includes('capital') || g.includes('reserve') || g.includes('surplus')) return 'Equity'
    if (g.includes('loan') || g.includes('advance') || g.includes('deposit')) return 'LoanAdvance'
    if (g.includes('provision') || g.includes('liability') || g.includes('current liabilit')) return 'Liability'
    return 'Other'
}

// ── Worker: tally-write (ERPNext → Tally) — tracks state only ────────────────

export function startTallyWriteWorker(): Worker<TallyWriteJobData, void, TallyWriteJobName> {
    const worker = new Worker<TallyWriteJobData, void, TallyWriteJobName>(
        'tally-write',
        async (job: Job<TallyWriteJobData, void, TallyWriteJobName>) => {
            const { companyId, action, tallyGuid } = job.data
            logger.info(
                { jobId: job.id, companyId, action, tallyGuid },
                'tally-write: tracking job delivery via long-poll',
            )
            // Actual write happens on connector; result arrives via POST /connector/sync-result
        },
        { connection: redisOpts, concurrency: 2 },
    )
    worker.on('completed', (job) => logger.info({ jobId: job.id }, 'tally-write completed'))
    worker.on('failed', (job, err) => logger.error({ jobId: job?.id, err }, 'tally-write failed'))
    return worker
}
