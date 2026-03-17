/**
 * Step 17 — Conflict detection.
 *
 * A conflict exists when both Tally and ERPNext have been modified
 * since the last successful sync of a record (PRD 6.3).
 *
 * Detection: tally_hash changed AND erpnext_hash changed vs stored hashes.
 */
import { sql, jsonb } from '../db/db'
import { broadcaster } from '../realtime/broadcaster'
import { logger } from '../lib/logger'
import type { TallyVoucher } from '../types'

export interface ConflictCheckResult {
    hasConflict: boolean
    syncRecordId?: string
    erpnextName?: string
    erpnextDoctype?: string
}

/**
 * Check if a Tally voucher coming in creates a conflict with ERPNext state.
 */
export async function checkConflict(
    companyId: string,
    voucher: TallyVoucher,
    newTallyHash: string,
): Promise<ConflictCheckResult> {
    const [record] = await sql<
        {
            id: string
            tally_hash: string
            erpnext_hash: string
            erpnext_name: string
            erpnext_doctype: string
            sync_status: string
        }[]
    >`
    SELECT id, tally_hash, erpnext_hash, erpnext_name, erpnext_doctype, sync_status
    FROM sync_records
    WHERE company_id = ${companyId} AND tally_guid = ${voucher.guid}
  `

    if (!record) {
        // New record — no conflict possible
        return { hasConflict: false }
    }

    const tallyChanged = record.tally_hash !== newTallyHash
    const erpnextChanged = record.erpnext_hash !== '' && record.erpnext_hash !== record.tally_hash

    // Both sides changed since last sync → real conflict
    if (tallyChanged && erpnextChanged) {
        return {
            hasConflict: true,
            syncRecordId: record.id,
            erpnextName: record.erpnext_name,
            erpnextDoctype: record.erpnext_doctype,
        }
    }

    // Only Tally changed — normal update, pass through existing ERP name for upsert
    if (tallyChanged) {
        return {
            hasConflict: false,
            syncRecordId: record.id,
            erpnextName: record.erpnext_name,
            erpnextDoctype: record.erpnext_doctype,
        }
    }

    // Hash unchanged — no update needed, skip
    return {
        hasConflict: false,
        syncRecordId: record.id,
    }
}

/**
 * Record a detected conflict into the DB and notify dashboard.
 */
export async function recordConflict(
    companyId: string,
    guid: string,
    tallySnapshot: unknown,
    erpnextSnapshot: unknown,
): Promise<void> {
    await sql`
    INSERT INTO conflict_log (company_id, tally_guid, tally_snapshot, erpnext_snapshot)
    VALUES (${companyId}, ${guid}, ${jsonb(tallySnapshot)}, ${jsonb(erpnextSnapshot)})
    ON CONFLICT DO NOTHING
  `

    broadcaster.emit(companyId, 'conflict:detected', {
        companyId,
        guid,
        detectedAt: new Date().toISOString(),
    })

    logger.warn({ companyId, guid }, 'Conflict recorded — human review required')
}
