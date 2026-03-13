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
            erpnext_url: string
            erpnext_api_key: string
            erpnext_api_secret: string
        }[]
    >`
    SELECT erpnext_company, erpnext_url, erpnext_api_key, erpnext_api_secret
    FROM companies WHERE id = ${companyId}
  `

    return {
        companyId,
        erpnextCompany: company?.erpnext_company ?? '',
        erpnextUrl: company?.erpnext_url ?? '',
        erpnextApiKey: company?.erpnext_api_key ?? '',
        erpnextApiSecret: company?.erpnext_api_secret ?? '',
        currency: 'INR',
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

            if (recordType !== 'voucher') {
                logger.info(
                    { companyId, recordType, count: records.length },
                    'Master data batch — skipping (engine handles vouchers only)',
                )
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
