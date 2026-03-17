/**
 * Step 10 — BullMQ queue definitions.
 * NOTE: BullMQ v5 bundles its own ioredis internally.
 * Pass a plain connection options object — NOT an ioredis instance.
 */
import { Queue } from 'bullmq'
import { env } from '../lib/env'
import { logger } from '../lib/logger'

// Parse Redis URL into host/port for BullMQ connection options.
function parseRedisUrl(url: string): { host: string; port: number; password?: string } {
    const u = new URL(url)
    return {
        host: u.hostname || 'localhost',
        port: u.port ? parseInt(u.port, 10) : 6379,
        password: u.password || undefined,
    }
}

export const redisOpts = {
    ...parseRedisUrl(env.REDIS_URL),
    maxRetriesPerRequest: null as unknown as number, // required by BullMQ
}

// Separate IORedis instance for our own use (heartbeat status, etc.)
// This one uses the npm ioredis package directly.
import IORedis from 'ioredis'
export const redis = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null })
redis.on('connect', () => logger.info('Redis connected'))
redis.on('error', (err) => logger.error({ err }, 'Redis error'))

// ── Job name types ─────────────────────────────────────────────────────────────
// BullMQ v5 requires the job name to be typed as a string literal union.

export type SyncJobName = 'transform-and-write'
export type TallyWriteJobName = 'write-to-tally'

// ── Queue: Tally → ERPNext transform + write ──────────────────────────────────

export type SyncJobData = {
    companyId: string
    batchId: string
    recordType: 'voucher' | 'ledger' | 'stockItem' | 'stockGroup' | 'uom' | 'godown'
    records: unknown[]
    fromTimestamp: string
    toTimestamp: string
}

export const syncJobsQueue = new Queue<SyncJobData, void, SyncJobName>('sync-jobs', {
    connection: redisOpts,
    defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: { count: 500 },
        removeOnFail: { count: 200 },
    },
})

// ── Queue: ERPNext → Tally write ───────────────────────────────────────────────

export type TallyWriteJobData = {
    companyId: string
    action: 'CREATE' | 'ALTER' | 'CANCEL'
    voucherType: string
    tallyGuid: string
    payload: Record<string, unknown>
}

export const tallyWriteQueue = new Queue<TallyWriteJobData, void, TallyWriteJobName>('tally-write', {
    connection: redisOpts,
    defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 3000 },
        removeOnComplete: { count: 500 },
        removeOnFail: { count: 200 },
    },
})
