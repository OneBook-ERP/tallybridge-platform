/**
 * Step 17 — Sync engine: orchestrates Tally→ERP and ERP→Tally flows.
 *
 * Called by the sync-jobs BullMQ worker with a batch of Tally records.
 * Responsibilities:
 *  1. Loop guard check (skip if we wrote this record)
 *  2. Conflict detection
 *  3. Transform Tally → ERPNext
 *  4. Write to ERPNext (create or cancel-amend)
 *  5. Update sync_records
 *  6. Write audit log entry
 */
import { sql } from '../db/db'
import { ERPNextClient, erpClient as defaultErpClient } from '../erpnext/client'
import { transformVoucher } from '../transform/tally-to-erp'
import { contentHash } from '../transform/utils'
import { isOwnWrite } from './loop-guard'
import { checkConflict, recordConflict } from './conflict'
import { broadcaster } from '../realtime/broadcaster'
import { logger } from '../lib/logger'
import type { TallyVoucher, CompanyConfig, ERPNextDocument } from '../types'

export interface SyncEngineResult {
    guid: string
    status: 'synced' | 'conflict' | 'error' | 'skipped'
    erpName?: string
    error?: string
}

// Config with optional per-company ERP credentials
interface ConfigWithCreds extends CompanyConfig {
    erpnextUrl?: string
    erpnextApiKey?: string
    erpnextApiSecret?: string
}

/**
 * Process one Tally voucher through the full Tally→ERP pipeline.
 */
export async function processTallyVoucher(
    voucher: TallyVoucher,
    config: ConfigWithCreds,
): Promise<SyncEngineResult> {
    // Use per-company ERP client if credentials are available, else fall back to env-var singleton
    const erpClient = (config.erpnextUrl && config.erpnextApiKey && config.erpnextApiSecret)
        ? new ERPNextClient({ baseUrl: config.erpnextUrl, apiKey: config.erpnextApiKey, apiSecret: config.erpnextApiSecret })
        : defaultErpClient
    const { guid } = voucher

    // PRD rule: skip optional (draft) vouchers — connector should have filtered, double-check here
    if (voucher.isOptional) {
        return { guid, status: 'skipped' }
    }

    // 1. Loop guard: did WE write this voucher recently?
    if (await isOwnWrite(config.companyId, guid)) {
        logger.debug({ guid }, 'Loop guard: skipping own-write GUID')
        return { guid, status: 'skipped' }
    }

    const newHash = contentHash(voucher)

    // 2. Conflict check — also skip if hash is unchanged (already synced successfully)
    const conflict = await checkConflict(config.companyId, voucher, newHash)
    if (conflict.syncRecordId && !conflict.erpnextName && !conflict.hasConflict) {
        // Hash unchanged and already synced — nothing to do
        return { guid, status: 'skipped' }
    }
    if (conflict.hasConflict && conflict.erpnextName) {
        const erpDoc = await erpClient.getDoc(conflict.erpnextDoctype!, conflict.erpnextName)
        await recordConflict(config.companyId, guid, voucher, erpDoc)

        // Apply conflict resolution strategy
        const strategy = config.conflictStrategy.perDoctype?.[conflict.erpnextDoctype!]
            ?? config.conflictStrategy.default

        if (strategy === 'MANUAL' || strategy === 'ERP_WINS') {
            return { guid, status: 'conflict', erpName: conflict.erpnextName }
        }
        // For TALLY_WINS and LAST_WRITE_WINS: continue and overwrite ERPNext
    }

    // 3. Transform
    const result = transformVoucher(voucher, config)
    if (!result.success) {
        const { code, message } = result.error
        const tier = code === 'UNMAPPED_LEDGER' || code === 'MISSING_GSTIN' ? 'TIER3_BLOCK' : 'TIER2_FLAG'

        // Record exception
        await sql`
      INSERT INTO exception_register (company_id, tier, document_ref, error_code, error_message)
      VALUES (${config.companyId}, ${tier}, ${'Voucher:' + guid}, ${code}, ${message})
    `
        broadcaster.emit(config.companyId, 'exception:new', { companyId: config.companyId, tier, message })
        return { guid, status: 'error', error: message }
    }

    // 3b. Auto-create missing master data in ERPNext
    try {
        const doc = result.doc as unknown as Record<string, unknown>
        const doctype = (result.doc as ERPNextDocument).doctype

        // Ensure party exists (pass GSTIN for India Compliance)
        if (doctype === 'Sales Invoice' && doc.customer) {
            await erpClient.ensureCustomer(doc.customer as string, (doc.customer_gstin as string) || undefined)
        }
        if (doctype === 'Purchase Invoice' && doc.supplier) {
            await erpClient.ensureSupplier(doc.supplier as string, (doc.supplier_gstin as string) || undefined)
        }
        if (doctype === 'Payment Entry' && doc.party) {
            if (doc.party_type === 'Customer') await erpClient.ensureCustomer(doc.party as string)
            else if (doc.party_type === 'Supplier') await erpClient.ensureSupplier(doc.party as string)
        }
        // Journal Entry — auto-create parties referenced in accounts
        if (doctype === 'Journal Entry' && Array.isArray(doc.accounts)) {
            for (const acct of doc.accounts as Array<{ party?: string; party_type?: string }>) {
                if (!acct.party) continue
                if (acct.party_type === 'Customer') await erpClient.ensureCustomer(acct.party)
                else if (acct.party_type === 'Supplier') await erpClient.ensureSupplier(acct.party)
            }
        }

        // Ensure items exist
        const items = (doc.items as Array<{ item_code: string; uom?: string; gst_hsn_code?: string }>) ?? []
        for (const item of items) {
            await erpClient.ensureItem(item.item_code, item.uom, item.gst_hsn_code)
        }
    } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err)
        logger.error({ guid, err }, 'Auto-create master data failed')
        await sql`
            INSERT INTO exception_register (company_id, tier, document_ref, error_code, error_message)
            VALUES (${config.companyId}, 'TIER2_FLAG', ${'Voucher:' + guid}, 'MASTER_CREATE_FAILED', ${errMsg})
        `
        return { guid, status: 'error', error: errMsg }
    }

    // 4. Write to ERPNext
    let erpName: string | undefined
    const doctype = (result.doc as ERPNextDocument).doctype

    try {
        if (conflict.erpnextName && conflict.erpnextDoctype) {
            // Update existing: cancel-amend pattern
            const doc = result.doc as unknown as Record<string, unknown>
            erpName = await erpClient.cancelAndAmend(conflict.erpnextDoctype, conflict.erpnextName, doc)
        } else {
            // Duplicate guard: check if ERPNext already has a doc with this tally_guid
            const existingName = await erpClient.findByTallyGUID(doctype, guid)
            if (existingName) {
                // Already exists in ERPNext — just record the sync record, don't create duplicate
                erpName = existingName
                logger.info({ guid, erpName, doctype }, 'Doc already exists in ERPNext — skipping create')
            } else {
                // New document
                const created = await erpClient.createDoc<{ name: string }>(doctype, result.doc as unknown as Record<string, unknown>)
                erpName = created.name
                // Auto-submit if configured
                await erpClient.submitDoc(doctype, erpName)
            }
        }
    } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err)
        logger.error({ guid, err, doctype }, 'ERPNext write failed')
        // Record ERPNext write failures as exceptions so they're visible in dashboard
        await sql`
            INSERT INTO exception_register (company_id, tier, document_ref, error_code, error_message)
            VALUES (${config.companyId}, 'TIER2_FLAG', ${'Voucher:' + guid}, 'ERPNEXT_WRITE_FAILED', ${errMsg})
        `
        return { guid, status: 'error', error: errMsg }
    }

    // 5. Update sync record
    await sql`
    INSERT INTO sync_records
      (company_id, tally_guid, erpnext_doctype, erpnext_name, tally_hash, sync_status, last_synced_at)
    VALUES
      (${config.companyId}, ${guid}, ${doctype}, ${erpName}, ${newHash}, 'SYNCED', now())
    ON CONFLICT (company_id, tally_guid) DO UPDATE SET
      erpnext_name    = EXCLUDED.erpnext_name,
      tally_hash      = EXCLUDED.tally_hash,
      sync_status     = 'SYNCED',
      last_synced_at  = now()
  `

    // 6. Audit log
    await sql`
    INSERT INTO audit_log (company_id, actor, event_type, document_ref, payload_after)
    VALUES (${config.companyId}, 'system', 'sync.tally_to_erp', ${`${doctype}:${erpName}`}, ${JSON.stringify(result.doc)}::jsonb)
  `

    if (result.warnings.length > 0) {
        logger.warn({ guid, warnings: result.warnings }, 'Sync completed with warnings')
    }

    return { guid, status: 'synced', erpName }
}
