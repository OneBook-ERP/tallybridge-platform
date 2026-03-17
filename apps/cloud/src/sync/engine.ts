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
import { sql, jsonb } from '../db/db'
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

/**
 * Resolve a Tally godown name to an ERPNext warehouse name.
 *
 * Priority:
 *  1. godown_warehouse_mapping table for the company
 *  2. "Main Location" → company's defaultWarehouse from config
 *  3. godownName + " - " + companyAbbr
 */
export async function resolveWarehouse(
    companyId: string,
    godownName: string,
    companyAbbr: string,
    defaultWarehouse?: string,
): Promise<string> {
    // 1. Check DB mapping table
    const [row] = await sql<{ erpnext_warehouse: string }[]>`
        SELECT erpnext_warehouse FROM godown_warehouse_mapping
        WHERE company_id = ${companyId} AND tally_godown = ${godownName}
        LIMIT 1
    `.catch(() => [])

    if (row?.erpnext_warehouse) return row.erpnext_warehouse

    // 2. "Main Location" → defaultWarehouse
    if (!godownName || godownName.toLowerCase() === 'main location') {
        return defaultWarehouse ?? `Stores - ${companyAbbr}`
    }

    // 3. Compose from godown name + company abbreviation
    return `${godownName} - ${companyAbbr}`
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
export async function processTallyVoucher(voucher: TallyVoucher, config: ConfigWithCreds): Promise<SyncEngineResult> {
    // Use per-company ERP client if credentials are available, else fall back to env-var singleton
    const erpClient =
        config.erpnextUrl && config.erpnextApiKey && config.erpnextApiSecret
            ? new ERPNextClient({
                  baseUrl: config.erpnextUrl,
                  apiKey: config.erpnextApiKey,
                  apiSecret: config.erpnextApiSecret,
              })
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
        const strategy =
            config.conflictStrategy.perDoctype?.[conflict.erpnextDoctype!] ?? config.conflictStrategy.default

        if (strategy === 'MANUAL' || strategy === 'ERP_WINS') {
            return { guid, status: 'conflict', erpName: conflict.erpnextName }
        }
        // For TALLY_WINS and LAST_WRITE_WINS: continue and overwrite ERPNext
    }

    // 3. Transform
    let result = transformVoucher(voucher, config)

    // 3a. UNMAPPED_LEDGER auto-heal for journal-like vouchers:
    // auto-create the GL account in ERPNext, persist the mapping, and retry.
    if (!result.success && result.error.code === 'UNMAPPED_LEDGER') {
        const unmappedLedger = result.error.field
        const vtLower = voucher.voucherTypeName.toLowerCase()
        const isJournalLike =
            vtLower.includes('journal') || vtLower.includes('contra') || vtLower.includes('debit note')
        if (isJournalLike && unmappedLedger && unmappedLedger !== 'partyGSTIN') {
            try {
                const abbr = config.erpnextAbbr ?? ''
                const erpAccount = await erpClient.ensureGLAccount(unmappedLedger, config.erpnextCompany, abbr)
                config.accountMappings[unmappedLedger] = erpAccount
                await sql`
                    UPDATE config_profiles
                    SET account_mappings = account_mappings || ${sql.json({ [unmappedLedger]: erpAccount })}
                    WHERE company_id = ${config.companyId}
                `
                result = transformVoucher(voucher, config)
                if (result.success) {
                    logger.info({ guid, unmappedLedger, erpAccount }, 'Auto-created GL account — transform retried OK')
                }
            } catch (autoErr) {
                logger.warn({ guid, unmappedLedger, err: autoErr }, 'Auto-create GL account failed')
            }
        }
    }

    if (!result.success) {
        const { code, message } = result.error

        // IGNORED_VOUCHER: HR/payroll/manufacturing types or all-__IGNORE__ journals — skip silently, no exception
        if (code === 'IGNORED_VOUCHER') {
            logger.debug({ guid, message }, 'Voucher ignored — not an accounting entry')
            return { guid, status: 'skipped' }
        }

        const tier = code === 'UNMAPPED_LEDGER' || code === 'MISSING_GSTIN' ? 'TIER3_BLOCK' : 'TIER2_FLAG'

        // Record exception
        await sql`
      INSERT INTO exception_register (company_id, tier, document_ref, error_code, error_message)
      VALUES (${config.companyId}, ${tier}, ${'Voucher:' + guid}, ${code}, ${message})
    `
        broadcaster.emit(config.companyId, 'exception:new', { companyId: config.companyId, tier, message })
        return { guid, status: 'error', error: message }
    }

    // 3b. Resolve payment references (bill-wise → sync_records lookup; FIFO fallback)
    if ((result.doc as ERPNextDocument).doctype === 'Payment Entry') {
        const payDoc = result.doc as unknown as {
            references?: Array<{ reference_doctype: string; reference_name: string; allocated_amount: number }>
            party?: string
            payment_type?: string
        }
        if (payDoc.references && payDoc.references.length > 0) {
            const resolved = []
            for (const ref of payDoc.references) {
                // Look up the ERPNext name by the Tally voucher number stored in sync_records
                const [record] = await sql<{ erpnext_name: string }[]>`
                    SELECT erpnext_name FROM sync_records
                    WHERE company_id = ${config.companyId}
                      AND erpnext_doctype = ${ref.reference_doctype}
                      AND tally_voucher_number = ${ref.reference_name}
                    LIMIT 1
                `
                if (record?.erpnext_name) {
                    resolved.push({ ...ref, reference_name: record.erpnext_name })
                } else {
                    logger.debug(
                        { ref, companyId: config.companyId },
                        'Payment reference not resolved — invoice may not be synced yet',
                    )
                }
            }

            // FIFO fallback: if no bill-wise references resolved but we have a party,
            // find the oldest outstanding invoices in ERPNext and allocate against them.
            if (resolved.length === 0 && payDoc.party) {
                try {
                    const isReceipt = payDoc.payment_type === 'Receive'
                    const invoiceDoctype = isReceipt ? 'Sales Invoice' : 'Purchase Invoice'
                    const partyField = isReceipt ? 'customer' : 'supplier'
                    const outstanding = await erpClient.listDocs<{ name: string; outstanding_amount: number }>(
                        invoiceDoctype,
                        [
                            [partyField, '=', payDoc.party],
                            ['docstatus', '=', 1],
                            ['outstanding_amount', '>', 0],
                        ],
                        ['name', 'outstanding_amount'],
                        'posting_date asc',
                        20,
                    )
                    let remaining =
                        (
                            result.doc as unknown as {
                                paid_amount?: number
                            }
                        ).paid_amount ?? 0
                    for (const inv of outstanding) {
                        if (remaining <= 0) break
                        const alloc = Math.min(remaining, inv.outstanding_amount)
                        resolved.push({
                            reference_doctype: invoiceDoctype,
                            reference_name: inv.name,
                            allocated_amount: alloc,
                        })
                        remaining -= alloc
                    }
                    if (resolved.length > 0) {
                        logger.debug({ party: payDoc.party, count: resolved.length }, 'FIFO payment references applied')
                    }
                } catch (err) {
                    logger.warn({ party: payDoc.party, err }, 'FIFO invoice lookup failed — payment will be unlinked')
                }
            }

            payDoc.references = resolved
        }
    }

    // 3b. Auto-create missing master data in ERPNext
    try {
        const doc = result.doc as unknown as Record<string, unknown>
        const doctype = (result.doc as ERPNextDocument).doctype

        // Helper: look up Tally group from ledger_masters for a party name.
        // Returns undefined for Tally accounting groups (Sundry Debtors/Creditors) — those are
        // not ERPNext business categories and will cause a validation error if passed as group.
        const ACCOUNTING_GROUPS = /sundry|debtor|creditor|cash|bank|loan|capital|reserve|provision/i
        const getPartyGroup = async (partyName: string): Promise<string | undefined> => {
            const [row] = await sql<{ tally_group: string | null }[]>`
                SELECT tally_group FROM ledger_masters
                WHERE company_id = ${config.companyId} AND tally_name = ${partyName}
                LIMIT 1
            `
            const group = row?.tally_group
            if (!group || ACCOUNTING_GROUPS.test(group)) return undefined
            return group
        }

        // Guard: returns true for bank, cash, capital, loan, reserve ledgers.
        // These must NEVER be created as Customer or Supplier in ERPNext.
        const isAccountingLedger = async (ledgerName: string): Promise<boolean> => {
            const [row] = await sql<{ tally_group: string | null }[]>`
                SELECT tally_group FROM ledger_masters
                WHERE company_id = ${config.companyId} AND tally_name = ${ledgerName}
                LIMIT 1
            `
            return ACCOUNTING_GROUPS.test(row?.tally_group || '')
        }

        // Helper: look up address/contact data from ledger_masters raw_data
        const getPartyMasterData = async (partyName: string) => {
            const [row] = await sql<{ raw_data: Record<string, unknown> | null }[]>`
                SELECT raw_data FROM ledger_masters
                WHERE company_id = ${config.companyId} AND tally_name = ${partyName}
                LIMIT 1
            `
            if (!row?.raw_data) return null
            const r = row.raw_data
            return {
                address: (r.Address ?? r.address ?? []) as string[],
                pinCode: (r.PinCode ?? r.pinCode ?? '') as string,
                state: (r.StateName ?? r.stateName ?? r.LedStateName ?? '') as string,
                country: (r.CountryName ?? r.countryName ?? '') as string,
                email: (r.Email ?? r.email ?? '') as string,
                mobile: (r.Mobile ?? r.mobile ?? r.LedgerMobile ?? '') as string,
                phone: (r.Phone ?? r.phone ?? r.LedgerPhone ?? '') as string,
                gstin: (r.PartyGSTIN ?? r.partyGSTIN ?? '') as string,
            }
        }

        // Helper: create address + contact for a party if master data exists
        const ensurePartyAddressContact = async (partyType: 'Customer' | 'Supplier', partyName: string) => {
            const master = await getPartyMasterData(partyName)
            if (!master) return
            if (master.address.length > 0 || master.pinCode) {
                await erpClient.ensurePartyAddress(partyType, partyName, {
                    lines: master.address,
                    pinCode: master.pinCode,
                    state: master.state,
                    country: master.country || 'India',
                    gstin: master.gstin,
                })
            }
            if (master.email || master.mobile || master.phone) {
                await erpClient.ensurePartyContact(partyType, partyName, {
                    email: master.email,
                    mobile: master.mobile,
                    phone: master.phone,
                })
            }
        }

        // Helper: look up item group from stock_item_masters
        const getItemGroup = async (itemName: string): Promise<string | undefined> => {
            const [row] = await sql<{ tally_parent: string | null }[]>`
                SELECT tally_parent FROM stock_item_masters
                WHERE company_id = ${config.companyId} AND tally_name = ${itemName}
                LIMIT 1
            `
            return row?.tally_parent || undefined
        }

        // Ensure party exists (pass GSTIN + group for India Compliance) + address/contact.
        // Skip bank/cash/capital ledgers — they are GL accounts, not business parties.
        if (doctype === 'Sales Invoice' && doc.customer) {
            const partyName = doc.customer as string
            if (!(await isAccountingLedger(partyName))) {
                const group = await getPartyGroup(partyName)
                await erpClient.ensureCustomer(partyName, (doc.customer_gstin as string) || undefined, group)
                await ensurePartyAddressContact('Customer', partyName)
            }
        }
        if (doctype === 'Purchase Invoice' && doc.supplier) {
            const partyName = doc.supplier as string
            if (!(await isAccountingLedger(partyName))) {
                const group = await getPartyGroup(partyName)
                await erpClient.ensureSupplier(partyName, (doc.supplier_gstin as string) || undefined, group)
                await ensurePartyAddressContact('Supplier', partyName)
            }
        }
        if (doctype === 'Payment Entry' && doc.party) {
            const partyName = doc.party as string
            if (!(await isAccountingLedger(partyName))) {
                const group = await getPartyGroup(partyName)
                if (doc.party_type === 'Customer') {
                    await erpClient.ensureCustomer(partyName, undefined, group)
                    await ensurePartyAddressContact('Customer', partyName)
                } else if (doc.party_type === 'Supplier') {
                    await erpClient.ensureSupplier(partyName, undefined, group)
                    await ensurePartyAddressContact('Supplier', partyName)
                }
            }
        }
        // Journal Entry — auto-create parties referenced in accounts (skip GL accounts)
        if (doctype === 'Journal Entry' && Array.isArray(doc.accounts)) {
            for (const acct of doc.accounts as Array<{ party?: string; party_type?: string }>) {
                if (!acct.party) continue
                if (await isAccountingLedger(acct.party)) continue
                const group = await getPartyGroup(acct.party)
                if (acct.party_type === 'Customer') {
                    await erpClient.ensureCustomer(acct.party, undefined, group)
                    await ensurePartyAddressContact('Customer', acct.party)
                } else if (acct.party_type === 'Supplier') {
                    await erpClient.ensureSupplier(acct.party, undefined, group)
                    await ensurePartyAddressContact('Supplier', acct.party)
                }
            }
        }

        // Ensure items exist (with UOM, group, HSN from stock_item_masters)
        const items = (doc.items as Array<{ item_code: string; uom?: string; gst_hsn_code?: string }>) ?? []
        for (const item of items) {
            if (item.uom && item.uom !== 'Nos') await erpClient.ensureUOM(item.uom)
            const itemGroup = await getItemGroup(item.item_code)
            if (itemGroup) await erpClient.ensureItemGroup(itemGroup)
            await erpClient.ensureItem(item.item_code, item.uom, item.gst_hsn_code, itemGroup)
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
                // Doc exists — check if it's still a draft (submit failed on prior attempt)
                const existing = await erpClient.getDoc<{ docstatus: number }>(doctype, existingName)
                if (existing.docstatus === 0) {
                    logger.info({ guid, erpName: existingName, doctype }, 'Found draft — attempting submit')
                    await erpClient.submitDoc(doctype, existingName)
                }
                erpName = existingName
                logger.info({ guid, erpName, doctype }, 'Doc already exists in ERPNext — recorded')
            } else {
                // New document
                const created = await erpClient.createDoc<{ name: string }>(
                    doctype,
                    result.doc as unknown as Record<string, unknown>,
                )
                erpName = created.name
                // Auto-submit if configured
                await erpClient.submitDoc(doctype, erpName)
            }
        }
    } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err)
        logger.warn({ guid, doctype, errMsg }, 'ERPNext write failed — attempting smart retry')

        // ── Smart retry logic ────────────────────────────────────────────────────
        // Each block tries a targeted fix for a known ERPNext validation error.
        // On success: erpName is set and we fall through to sync_records upsert.
        // On failure: falls through to exception recording below.

        let retrySuccess = false

        try {
            const docPayload = result.doc as unknown as Record<string, unknown>

            // Retry 1: Negative stock — disable update_stock so ERPNext doesn't validate inventory
            if (/units of.*needed in.*Warehouse/i.test(errMsg) && doctype === 'Sales Invoice') {
                logger.info({ guid }, 'Retrying Sales Invoice with update_stock=0 (negative stock)')
                const retryDoc = { ...docPayload, update_stock: 0, set_warehouse: undefined }
                const created = await erpClient.createDoc<{ name: string }>(doctype, retryDoc)
                erpName = created.name
                await erpClient.submitDoc(doctype, erpName)
                retrySuccess = true
            }

            // Retry 2: Payment references exceed outstanding — strip references, post as unallocated advance
            else if (
                /Allocated Amount cannot be greater than outstanding/i.test(errMsg) &&
                doctype === 'Payment Entry'
            ) {
                logger.info({ guid }, 'Retrying Payment Entry without references (allocation > outstanding)')
                const retryDoc = { ...docPayload, references: [] }
                const created = await erpClient.createDoc<{ name: string }>(doctype, retryDoc)
                erpName = created.name
                await erpClient.submitDoc(doctype, erpName)
                retrySuccess = true
            }

            // Retry 3: GST category mismatch — downgrade to Unregistered (customer not registered in ERPNext)
            else if (/GST Category should be one of.*Unregistered.*Overseas/i.test(errMsg)) {
                logger.info({ guid }, 'Retrying with gst_category=Unregistered (GST category mismatch)')
                const retryDoc = {
                    ...docPayload,
                    gst_category: 'Unregistered',
                    customer_gstin: undefined,
                    is_inter_state: 0,
                }
                const created = await erpClient.createDoc<{ name: string }>(doctype, retryDoc)
                erpName = created.name
                await erpClient.submitDoc(doctype, erpName)
                retrySuccess = true
            }

            // Retry 4: GST amount mismatch — disable tax rate recalculation
            else if (/GST amounts do not match/i.test(errMsg)) {
                logger.info({ guid }, 'Retrying with tax_category override to bypass GST amount recalculation')
                const taxes = ((docPayload.taxes as Array<Record<string, unknown>>) ?? []).map((t) => ({
                    ...t,
                    charge_type: 'Actual', // pass exact tax_amount without rate recalculation
                }))
                const retryDoc = { ...docPayload, taxes }
                const created = await erpClient.createDoc<{ name: string }>(doctype, retryDoc)
                erpName = created.name
                await erpClient.submitDoc(doctype, erpName)
                retrySuccess = true
            }

            // Retry 5: Invalid GST account for transaction — account type doesn't match inter/intra-state.
            // Use charge_type=Actual to bypass India Compliance GST account type validation.
            else if (/is not a valid GST account for this transaction/i.test(errMsg)) {
                logger.info({ guid }, 'Retrying with charge_type=Actual (invalid GST account)')
                const taxes = ((docPayload.taxes as Array<Record<string, unknown>>) ?? []).map((t) => ({
                    ...t,
                    charge_type: 'Actual',
                }))
                const retryDoc = { ...docPayload, taxes }
                const created = await erpClient.createDoc<{ name: string }>(doctype, retryDoc)
                erpName = created.name
                await erpClient.submitDoc(doctype, erpName)
                retrySuccess = true
            }

            // Retry 6: Fractional quantity rejected — UOM has "Must be Whole Number" enabled.
            // Round down qty/stock_qty on all items and retry.
            else if (/cannot be a fraction/i.test(errMsg)) {
                logger.info({ guid }, 'Retrying with integer quantities (UOM Must be Whole Number)')
                const items = ((docPayload.items as Array<Record<string, unknown>>) ?? []).map((item) => ({
                    ...item,
                    qty: Math.floor(Number(item.qty) || 0),
                    stock_qty: Math.floor(Number(item.stock_qty) || 0),
                }))
                const retryDoc = { ...docPayload, items }
                const created = await erpClient.createDoc<{ name: string }>(doctype, retryDoc)
                erpName = created.name
                await erpClient.submitDoc(doctype, erpName)
                retrySuccess = true
            }
        } catch (retryErr: unknown) {
            const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr)
            logger.error({ guid, doctype, retryMsg }, 'Smart retry also failed')
        }

        if (!retrySuccess) {
            // Record ERPNext write failures as exceptions so they're visible in dashboard
            await sql`
                INSERT INTO exception_register (company_id, tier, document_ref, error_code, error_message)
                VALUES (${config.companyId}, 'TIER2_FLAG', ${'Voucher:' + guid}, 'ERPNEXT_WRITE_FAILED', ${errMsg})
            `
            return { guid, status: 'error', error: errMsg }
        }
    }

    // 5. Update sync record (include tally_voucher_number for payment reference resolution)
    const tallyVoucherNumber = voucher.voucherNumber ?? null
    await sql`
    INSERT INTO sync_records
      (company_id, tally_guid, tally_voucher_number, erpnext_doctype, erpnext_name, tally_hash, sync_status, last_synced_at)
    VALUES
      (${config.companyId}, ${guid}, ${tallyVoucherNumber}, ${doctype}, ${erpName ?? null}, ${newHash}, 'SYNCED', now())
    ON CONFLICT (company_id, tally_guid) DO UPDATE SET
      erpnext_name         = EXCLUDED.erpnext_name,
      tally_voucher_number = EXCLUDED.tally_voucher_number,
      tally_hash           = EXCLUDED.tally_hash,
      sync_status          = 'SYNCED',
      last_synced_at       = now()
  `

    // 6. Audit log
    await sql`
    INSERT INTO audit_log (company_id, actor, event_type, document_ref, payload_after)
    VALUES (${config.companyId}, 'system', 'sync.tally_to_erp', ${`${doctype}:${erpName}`}, ${jsonb(result.doc)})
  `

    if (result.warnings.length > 0) {
        logger.warn({ guid, warnings: result.warnings }, 'Sync completed with warnings')
    }

    return { guid, status: 'synced', erpName }
}
