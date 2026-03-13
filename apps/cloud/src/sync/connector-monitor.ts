/**
 * Connector monitor — periodically checks for stale heartbeats
 * and marks connectors as OFFLINE if no heartbeat received in 90 seconds.
 */
import { sql } from '../db/db'
import { broadcaster } from '../realtime/broadcaster'
import { logger } from '../lib/logger'

const STALE_THRESHOLD_SECONDS = 90
const CHECK_INTERVAL_MS = 30_000 // check every 30 seconds

export function startConnectorMonitor(): ReturnType<typeof setInterval> {
    return setInterval(async () => {
        try {
            const stale = await sql<{ id: string; tally_company_name: string }[]>`
                UPDATE companies
                SET connector_status = 'OFFLINE'
                WHERE connector_status = 'ONLINE'
                  AND last_heartbeat_at < now() - interval '${sql.unsafe(String(STALE_THRESHOLD_SECONDS))} seconds'
                RETURNING id, tally_company_name
            `

            for (const company of stale) {
                broadcaster.emit(company.id, 'connector:status', {
                    companyId: company.id,
                    status: 'OFFLINE',
                    tallyStatus: 'UNKNOWN',
                    at: new Date().toISOString(),
                })
                logger.warn(
                    { companyId: company.id, company: company.tally_company_name },
                    'Connector marked OFFLINE — no heartbeat',
                )
            }
        } catch (err) {
            logger.error({ err }, 'Connector monitor check failed')
        }
    }, CHECK_INTERVAL_MS)
}
