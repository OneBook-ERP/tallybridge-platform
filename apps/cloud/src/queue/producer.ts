/**
 * Job producer — enqueue jobs onto BullMQ queues.
 */
import {
    syncJobsQueue,
    tallyWriteQueue,
    type SyncJobData,
    type TallyWriteJobData,
    type SyncJobName,
    type TallyWriteJobName,
} from './queues'
import { wakeConnector, type PendingJob } from '../api/connector/jobs'
import { markWritten } from '../sync/loop-guard'
import { sql } from '../db/db'
import { logger } from '../lib/logger'

// Priority scheme (lower number = higher priority in BullMQ):
//   1 = ledger masters      — must complete before stock items
//   2 = stock item masters  — must complete before vouchers
//  10 = vouchers            — Purchase(10) → Sales(11) → Journal(12) → Payment(13)
//
// BullMQ always dequeues the lowest-priority-number job when a worker slot is free,
// so ledgers fully drain before stock items start, and stock items drain before vouchers.
// Concurrency > 1 gives parallelism within the same priority level (e.g. 5 ledger batches at once).

function voucherPriority(records: unknown[]): number {
    // Scan the first record to detect the dominant voucher type, then assign sub-priority.
    const first = records[0] as Record<string, unknown> | undefined
    if (!first) return 10
    const vtype = (
        first['VoucherTypeName'] ??
        first['voucherTypeName'] ??
        first['VOUCHERTYPENAME'] ??
        ''
    ) as string
    if (/purchase/i.test(vtype)) return 10
    if (/sales/i.test(vtype)) return 11
    if (/journal|contra/i.test(vtype)) return 12
    if (/payment|receipt/i.test(vtype)) return 13
    return 10
}

export async function enqueueSyncBatch(data: SyncJobData): Promise<string> {
    let priority: number
    if (data.recordType === 'ledger') priority = 1
    else if (data.recordType === 'stockItem') priority = 2
    else priority = voucherPriority(data.records)

    const job = await (syncJobsQueue as import('bullmq').Queue<SyncJobData, void, SyncJobName>).add(
        'transform-and-write',
        data,
        { jobId: data.batchId, priority },
    )
    logger.info({ jobId: job.id, companyId: data.companyId, type: data.recordType, priority }, 'Sync batch enqueued')
    return job.id!
}

export async function enqueueTallyWrite(data: TallyWriteJobData): Promise<string> {
    const [row] = await sql<{ id: string }[]>`
    INSERT INTO job_log
      (company_id, job_type, direction, status, payload)
    VALUES
      (${data.companyId}, ${data.action}, 'ERP_TO_TALLY', 'PENDING',
       ${sql.json(data.payload as Record<string, string>)})
    RETURNING id
  `
    const jobLogId = row.id

    // Loop guard: mark this GUID so the next Tally→ERP delta poll skips it
    if (data.tallyGuid) {
        await markWritten(data.companyId, data.tallyGuid)
    }

    await (tallyWriteQueue as import('bullmq').Queue<TallyWriteJobData, void, TallyWriteJobName>).add(
        'write-to-tally',
        data,
        { jobId: jobLogId },
    )

    const pendingJob: PendingJob = {
        jobId: jobLogId,
        action: data.action,
        voucherType: data.voucherType,
        payload: data.payload,
    }
    wakeConnector(data.companyId, [pendingJob])

    logger.info({ jobId: jobLogId, companyId: data.companyId }, 'Tally write job enqueued')
    return jobLogId
}
