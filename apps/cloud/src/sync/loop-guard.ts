/**
 * Step 18 — Sync loop guard.
 *
 * Prevents an ERPNext→Tally write from triggering Tally→ERPNext→Tally loops.
 *
 * How it works:
 * 1. Before writing to Tally, record the GUID in Redis with a short TTL.
 * 2. When the Tally delta poll picks up that same GUID, check Redis first.
 *    If it's there, skip it — the change was our own write.
 * 3. The TTL covers the maximum delay between write and next poll cycle.
 */
import { redis } from '../queue/queues'
import { logger } from '../lib/logger'

const PREFIX = 'tb:guard:'
const TTL_SECONDS = 120  // 2 minutes — covers any poll interval

/**
 * Mark a GUID as "written by us" before shipping to connector.
 * Must be called BEFORE the job is delivered to connector.
 */
export async function markWritten(companyId: string, guid: string): Promise<void> {
    const key = `${PREFIX}${companyId}:${guid}`
    await redis.set(key, '1', 'EX', TTL_SECONDS)
    logger.debug({ companyId, guid }, 'Loop guard: marked GUID as written')
}

/**
 * Returns true if this GUID was written by TallyBridge recently.
 * The connector's delta payload is checked here — skip if true.
 */
export async function isOwnWrite(companyId: string, guid: string): Promise<boolean> {
    const key = `${PREFIX}${companyId}:${guid}`
    const val = await redis.get(key)
    return val === '1'
}

/**
 * Clear the loop-guard mark once the sync cycle has confirmed the round-trip.
 * Optional — the TTL will expire naturally, but explicit clear is cleaner.
 */
export async function clearWritten(companyId: string, guid: string): Promise<void> {
    const key = `${PREFIX}${companyId}:${guid}`
    await redis.del(key)
}
