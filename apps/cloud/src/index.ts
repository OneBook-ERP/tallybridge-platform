/**
 * Entry point — starts the Fastify server with graceful shutdown.
 */
import { buildApp } from './app'
import { env } from './lib/env'
import { logger } from './lib/logger'
import { checkConnection, closeConnection } from './db/db'
import { startSyncWorker, startTallyWriteWorker } from './queue/consumer'
import { startConnectorMonitor } from './sync/connector-monitor'

async function main(): Promise<void> {
    // 1. Verify DB is reachable before accepting traffic.
    await checkConnection()

    // 2. Build Fastify app.
    const app = await buildApp()

    // 3. Start BullMQ workers.
    const syncWorker = startSyncWorker()
    const tallyWorker = startTallyWriteWorker()

    // 4. Start connector monitor (marks OFFLINE after 90s no heartbeat).
    const monitorInterval = startConnectorMonitor()

    // 5. Start listening.
    await app.listen({ port: env.PORT, host: env.HOST })
    logger.info(`TallyBridge Cloud listening on ${env.HOST}:${env.PORT}`)

    // ── Graceful shutdown ────────────────────────────────────────────────────────
    const shutdown = async (signal: string) => {
        logger.info(`${signal} received — shutting down`)
        await app.close()
        clearInterval(monitorInterval)
        await syncWorker.close()
        await tallyWorker.close()
        await closeConnection()
        logger.info('Shutdown complete')
        process.exit(0)
    }

    process.on('SIGTERM', () => shutdown('SIGTERM'))
    process.on('SIGINT', () => shutdown('SIGINT'))
}

main().catch((err) => {
    logger.error({ err }, 'Fatal startup error')
    process.exit(1)
})
