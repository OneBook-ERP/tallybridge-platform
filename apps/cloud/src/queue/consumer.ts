/**
 * Step 10 (updated) — BullMQ workers, now wired to the sync engine.
 */
import { Worker, type Job } from 'bullmq'
import { redisOpts, type SyncJobData, type TallyWriteJobData, type SyncJobName, type TallyWriteJobName } from './queues'
import { processTallyVoucher } from '../sync/engine'
import { normalizeVoucher } from '../transform/normalize'
import { broadcaster } from '../realtime/broadcaster'
import { ERPNextClient } from '../erpnext/client'
import { sql } from '../db/db'
import { logger } from '../lib/logger'
import type { TallyVoucher, CompanyConfig } from '../types'
import { stateFromGstin } from '../transform/utils'
import { buildDefaultMappings } from '../transform/default-mappings'

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
            erpnext_gstin: string | null
            erpnext_url: string
            erpnext_api_key: string
            erpnext_api_secret: string
        }[]
    >`
    SELECT erpnext_company, erpnext_abbr, erpnext_gstin, erpnext_url, erpnext_api_key, erpnext_api_secret
    FROM companies WHERE id = ${companyId}
  `

    const abbr = company?.erpnext_abbr ?? ''

    // Resolve company billing address dynamically from ERPNext
    const gstin = company?.erpnext_gstin ?? ''
    let companyAddress: string | undefined
    if (company?.erpnext_url && company?.erpnext_api_key && company?.erpnext_api_secret) {
        try {
            const erpClient = new ERPNextClient({
                baseUrl: company.erpnext_url,
                apiKey: company.erpnext_api_key,
                apiSecret: company.erpnext_api_secret,
            })
            companyAddress = await erpClient.ensureCompanyAddress(company.erpnext_company, gstin)
        } catch (err) {
            logger.warn({ err }, 'Could not resolve company address — falling back to naming convention')
        }
    }

    // Load bank/cash ledger names + all ledger groups from ledger_masters.
    // bankLedgers: prevents aggressive party fallback for bank/cash accounts.
    // ledgerGroups: group-based default resolution (e.g. "Sales Accounts" → "Sales - ABBR").
    const ledgerMasterRows = await sql<{ tally_name: string; tally_group: string | null; ledger_type: string | null }[]>`
        SELECT tally_name, tally_group, ledger_type FROM ledger_masters
        WHERE company_id = ${companyId}
    `
    const bankLedgers: string[] = []
    const ledgerGroups: Record<string, string> = {}
    for (const r of ledgerMasterRows) {
        if (r.ledger_type === 'Bank' || r.ledger_type === 'Cash') bankLedgers.push(r.tally_name)
        if (r.tally_group) ledgerGroups[r.tally_name] = r.tally_group
    }

    const { groupDefaultMappings } = buildDefaultMappings(abbr)

    return {
        companyId,
        erpnextCompany: company?.erpnext_company ?? '',
        erpnextAbbr: abbr,
        erpnextUrl: company?.erpnext_url ?? '',
        erpnextApiKey: company?.erpnext_api_key ?? '',
        erpnextApiSecret: company?.erpnext_api_secret ?? '',
        currency: 'INR',
        costCenter: abbr ? `Main - ${abbr}` : undefined,
        companyGstin: gstin,
        companyAddress,
        defaultState: gstin ? (stateFromGstin(gstin) ?? '') : '',
        defaultWarehouse: abbr ? `Stores - ${abbr}` : undefined,
        updateStock: true,
        bankLedgers,
        ledgerGroups,
        groupDefaultMappings,
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
                await processMasterData(companyId, 'ledger', records as Record<string, unknown>[], config)
                return
            }
            if (recordType === 'stockItem') {
                await processMasterData(companyId, 'stockItem', records as Record<string, unknown>[], config)
                return
            }
            if (recordType === 'stockGroup') {
                await processMasterData(companyId, 'stockGroup', records as Record<string, unknown>[], config)
                return
            }
            if (recordType === 'uom') {
                await processMasterData(companyId, 'uom', records as Record<string, unknown>[], config)
                return
            }
            if (recordType === 'godown') {
                await processMasterData(companyId, 'godown', records as Record<string, unknown>[], config)
                return
            }

            // Sort vouchers: Purchase → Sales → Journal/Contra → Payment/Receipt
            // This ensures stock exists before sales, and invoices exist before payments.
            // Keys use Tally voucherTypeName values (not ERPNext doctype names).
            const VOUCHER_ORDER: Record<string, number> = {
                Purchase: 0,
                'Debit Note': 0,
                Sales: 1,
                'Credit Note': 1,
                Journal: 2,
                Contra: 2,
                Payment: 3,
                Receipt: 3,
            }
            const sorted = [...records].sort((a, b) => {
                const n = normalizeVoucher(a as Record<string, unknown>)
                const m = normalizeVoucher(b as Record<string, unknown>)
                const ao = VOUCHER_ORDER[(n as unknown as TallyVoucher).voucherTypeName] ?? 2
                const bo = VOUCHER_ORDER[(m as unknown as TallyVoucher).voucherTypeName] ?? 2
                return ao - bo
            })

            let synced = 0,
                errored = 0,
                skipped = 0

            for (const raw of sorted) {
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
        // concurrency: 5 allows 5 jobs to run in parallel.
        // Ordering is maintained via job priorities (see producer.ts):
        //   ledger (1) → stockItem (2) → vouchers (10-13)
        // BullMQ always picks the lowest-priority-number job from the queue when a slot is free,
        // so all ledger batches drain before stock batches start, and all stock batches drain
        // before voucher batches start. Within the same priority level, jobs run concurrently.
        { connection: redisOpts, concurrency: 5 },
    )

    worker.on('completed', (job) => logger.info({ jobId: job.id }, 'sync-jobs completed'))
    worker.on('failed', (job, err) => logger.error({ jobId: job?.id, err }, 'sync-jobs failed'))
    return worker
}

// ── Helper: process master data (ledgers, stock items, stock groups, UOMs, godowns) ───
async function processMasterData(
    companyId: string,
    type: 'ledger' | 'stockItem' | 'stockGroup' | 'uom' | 'godown',
    records: Record<string, unknown>[],
    config: CompanyConfigWithCreds,
): Promise<void> {
    let upserted = 0
    const erpClient = new ERPNextClient({
        baseUrl: config.erpnextUrl,
        apiKey: config.erpnextApiKey,
        apiSecret: config.erpnextApiSecret,
    })
    const abbr = config.erpnextAbbr ?? ''

    for (const raw of records) {
        try {
            if (type === 'ledger') {
                const name = (raw.Name ?? raw.name ?? raw.NAME ?? '') as string
                if (!name) continue

                const parent = (raw.Parent ?? raw.parent ?? raw.PARENT ?? '') as string
                // Tally sends the group name as PARENT on a ledger (e.g. "Sundry Debtors").
                // There is no separate GROUP field — parent IS the group.
                const group = parent
                const gstin = (raw.GSTIN ?? raw.Gstin ?? raw.gstin ?? '') as string
                const isParty = (raw.IsPartyLedger ?? raw.isPartyLedger ?? raw.ISPARTYLEDGER ?? false) as boolean
                const openBal =
                    parseFloat(String(raw.OpeningBalance ?? raw.openingBalance ?? raw.OPENINGBALANCE ?? 0)) || 0

                // Classify ledger type from Tally group hierarchy
                const ledgerType = classifyLedger(group, parent)

                await sql`
                    INSERT INTO ledger_masters (company_id, tally_name, tally_parent, tally_group, opening_balance, gstin, is_party_ledger, ledger_type, raw_data, synced_at)
                    VALUES (${companyId}, ${name}, ${parent}, ${group}, ${openBal}, ${gstin || null}, ${isParty}, ${ledgerType}, ${sql.json(raw as never)}, now())
                    ON CONFLICT (company_id, tally_name)
                    DO UPDATE SET tally_parent = EXCLUDED.tally_parent, tally_group = EXCLUDED.tally_group,
                                  opening_balance = EXCLUDED.opening_balance, gstin = EXCLUDED.gstin,
                                  is_party_ledger = EXCLUDED.is_party_ledger, ledger_type = EXCLUDED.ledger_type,
                                  raw_data = EXCLUDED.raw_data, synced_at = now()
                `
                upserted++

                // Push master to ERPNext based on type
                try {
                    if (ledgerType === 'Customer') {
                        await erpClient.ensureCustomer(name, gstin || undefined, group || undefined)
                    } else if (ledgerType === 'Supplier') {
                        await erpClient.ensureSupplier(name, gstin || undefined, group || undefined)
                    } else if (ledgerType === 'Bank' || ledgerType === 'Cash') {
                        // Auto-create GL account in ERPNext COA and persist the mapping
                        const erpAccountName = await erpClient.ensureBankGLAccount(name, config.erpnextCompany, abbr)
                        // Persist mapping to config_profiles so voucher processing can resolve it
                        await sql`
                            UPDATE config_profiles
                            SET account_mappings = account_mappings || ${sql.json({ [name]: erpAccountName })}
                            WHERE company_id = ${companyId}
                        `
                    }
                } catch (erpErr) {
                    logger.warn({ type, name, ledgerType, err: erpErr }, 'ERPNext master push failed — skipping')
                }
            } else if (type === 'stockItem') {
                const name = (raw.Name ?? raw.name ?? raw.NAME ?? '') as string
                if (!name) continue

                const parent = (raw.Parent ?? raw.parent ?? raw.PARENT ?? '') as string
                const uom = (raw.BaseUnits ?? raw.baseUnits ?? raw.BASEUNITS ?? raw.UOM ?? raw.uom ?? '') as string
                const hsn = (raw.HSNCode ?? raw.hsnCode ?? raw.HSNCODE ?? '') as string
                const openQty = parseFloat(String(raw.OpeningBalance ?? raw.openingBalance ?? raw.OpeningQty ?? 0)) || 0
                // OpeningValue is the total value from Tally (qty × rate).
                // OpeningRate is per-unit; OpeningValue is the preferred source if non-zero.
                const openRate = parseFloat(String(raw.OpeningRate ?? raw.openingRate ?? 0)) || 0
                const tallyOpenVal = parseFloat(String(raw.OpeningValue ?? raw.openingValue ?? 0)) || 0
                // Prefer Tally's total value; fall back to qty × rate
                const openVal = tallyOpenVal !== 0 ? tallyOpenVal : openQty * openRate

                await sql`
                    INSERT INTO stock_item_masters (company_id, tally_name, tally_parent, uom, hsn_code, opening_qty, opening_value, raw_data, synced_at)
                    VALUES (${companyId}, ${name}, ${parent}, ${uom || null}, ${hsn || null}, ${openQty}, ${openVal}, ${sql.json(raw as never)}, now())
                    ON CONFLICT (company_id, tally_name)
                    DO UPDATE SET tally_parent = EXCLUDED.tally_parent, uom = EXCLUDED.uom,
                                  hsn_code = EXCLUDED.hsn_code, opening_qty = EXCLUDED.opening_qty,
                                  opening_value = EXCLUDED.opening_value, raw_data = EXCLUDED.raw_data, synced_at = now()
                `
                upserted++

                // Push item to ERPNext — ensure UOM + Item Group exist first
                try {
                    if (uom && uom !== 'Nos') await erpClient.ensureUOM(uom)
                    if (parent) await erpClient.ensureItemGroup(parent)
                    await erpClient.ensureItem(name, uom || undefined, hsn || undefined, parent || undefined)
                } catch (erpErr) {
                    logger.warn({ name, err: erpErr }, 'ERPNext item push failed — skipping')
                }
            } else if (type === 'stockGroup') {
                // Stock groups → ERPNext Item Groups
                const name = (raw.Name ?? raw.name ?? raw.NAME ?? '') as string
                if (!name) continue
                try {
                    await erpClient.ensureItemGroup(name)
                    upserted++
                } catch (erpErr) {
                    logger.warn({ name, err: erpErr }, 'ERPNext Item Group push failed — skipping')
                }
            } else if (type === 'uom') {
                // UOMs → ERPNext UOM
                const name = (raw.Name ?? raw.name ?? raw.NAME ?? '') as string
                if (!name || name === 'Nos') continue
                try {
                    await erpClient.ensureUOM(name)
                    upserted++
                } catch (erpErr) {
                    logger.warn({ name, err: erpErr }, 'ERPNext UOM push failed — skipping')
                }
            } else if (type === 'godown') {
                // Godowns → store default mapping in godown_warehouse_mapping
                // Default: godown name + " - " + companyAbbr
                const name = (raw.Name ?? raw.name ?? raw.NAME ?? '') as string
                if (!name) continue
                const abbr = config.erpnextAbbr ?? ''
                const defaultWarehouse =
                    name.toLowerCase() === 'main location'
                        ? (config.defaultWarehouse ?? `Stores - ${abbr}`)
                        : `${name} - ${abbr}`
                try {
                    await sql`
                        INSERT INTO godown_warehouse_mapping (company_id, tally_godown, erpnext_warehouse)
                        VALUES (${companyId}, ${name}, ${defaultWarehouse})
                        ON CONFLICT (company_id, tally_godown) DO NOTHING
                    `
                    upserted++
                } catch (dbErr) {
                    logger.warn({ name, err: dbErr }, 'Godown mapping upsert failed — skipping')
                }
            }
        } catch (err) {
            logger.warn({ type, name: raw.Name ?? raw.name, err }, 'Master data upsert failed')
        }
    }

    logger.info({ companyId, type, upserted, total: records.length }, 'Master data batch processed')

    // After stock items are synced, create a one-time opening stock entry in ERPNext.
    // This sets initial inventory levels so purchase invoices don't cause negative stock.
    if (type === 'stockItem') {
        const openingRows = await sql<
            { tally_name: string; opening_qty: number; opening_value: number; uom: string | null }[]
        >`
            SELECT tally_name, opening_qty, opening_value, uom
            FROM stock_item_masters
            WHERE company_id = ${companyId} AND opening_qty > 0
        `
        if (openingRows.length > 0) {
            // Derive FY start: use earliest voucher date in sync_records (if any), else April 1st
            const [earliest] = await sql<{ d: string }[]>`
                SELECT MIN(posting_date::date)::text AS d FROM sync_records WHERE company_id = ${companyId}
            `.catch(() => [])
            const fyStart = earliest?.d ?? indianFYStart()
            await erpClient.ensureOpeningStockEntry(
                openingRows.map((r) => ({
                    itemCode: r.tally_name,
                    qty: r.opening_qty,
                    // Tally stores OPENINGVALUE as negative (credit convention) — use abs for valuation rate
                    rate: r.opening_qty > 0 ? Math.abs(Number(r.opening_value)) / Number(r.opening_qty) : 0,
                    uom: r.uom ?? 'Nos',
                })),
                config.erpnextCompany,
                config.defaultWarehouse ?? `Stores - ${config.erpnextAbbr ?? ''}`,
                fyStart,
                config.costCenter,
            )
        }
    }
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

/** Returns "YYYY-04-01" for the current Indian FY start (April 1). */
function indianFYStart(): string {
    const now = new Date()
    const year = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1
    return `${year}-04-01`
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
