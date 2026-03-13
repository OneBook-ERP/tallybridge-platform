/**
 * Job producer — enqueue jobs onto BullMQ queues.
 */
import {
  syncJobsQueue, tallyWriteQueue,
  type SyncJobData, type TallyWriteJobData,
  type SyncJobName, type TallyWriteJobName,
} from './queues'
import { wakeConnector, type PendingJob } from '../api/connector/jobs'
import { markWritten } from '../sync/loop-guard'
import { sql } from '../db/db'
import { logger } from '../lib/logger'

export async function enqueueSyncBatch(data: SyncJobData): Promise<string> {
  const job = await (syncJobsQueue as import('bullmq').Queue<SyncJobData, void, SyncJobName>)
    .add('transform-and-write', data, { jobId: data.batchId })
  logger.info({ jobId: job.id, companyId: data.companyId, type: data.recordType }, 'Sync batch enqueued')
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

  await (tallyWriteQueue as import('bullmq').Queue<TallyWriteJobData, void, TallyWriteJobName>)
    .add('write-to-tally', data, { jobId: jobLogId })

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
