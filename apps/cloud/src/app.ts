/**
 * Fastify application factory.
 * All plugins and routes are registered here.
 * index.ts imports this and calls listen().
 */
import Fastify from 'fastify'
import cors from '@fastify/cors'
import { logger } from './lib/logger'
import { errorHandler } from './lib/errors'

// Routes — Step 8
import { registerRoute } from './api/connector/register'
import { heartbeatRoute } from './api/connector/heartbeat'
import { configRoute } from './api/connector/config'

// Routes — Step 9
import { jobsRoute } from './api/connector/jobs'
import { resultRoute, exceptionRoute } from './api/connector/result'

// Route — Step 17
import { syncDataRoute } from './api/connector/sync-data'

// Webhook — ERPNext → Tally
import { erpnextWebhookRoute } from './api/webhook/erpnext'

// Dashboard API
import { dashboardRoutes } from './api/dashboard/routes'

// WebSocket — Step 11
import { websocketPlugin } from './realtime/websocket'

export async function buildApp() {
    const app = Fastify({
        logger: false, // we use our own pino instance
        trustProxy: true,
        bodyLimit: 50 * 1024 * 1024, // 50 MB — large Tally sync batches can be 10–30 MB
    })

    // ── Plugins ────────────────────────────────────────────────────────────────
    await app.register(cors, {
        origin: true, // tighten in production
        methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    })

    // ── Error handler ──────────────────────────────────────────────────────────
    app.setErrorHandler((error, request, reply) => {
        logger.error({ err: error, path: request.url }, 'Request error')
        errorHandler(error, request, reply as Parameters<typeof errorHandler>[2])
    })

    // ── Health check ───────────────────────────────────────────────────────────
    app.get('/health', async () => {
        let dbOk = false
        let redisOk = false
        try {
            const { sql: dbSql } = await import('./db/db')
            await dbSql`SELECT 1`
            dbOk = true
        } catch {
            /* db unavailable */
        }
        try {
            const { redis } = await import('./queue/queues')
            const pong = await redis.ping()
            redisOk = pong === 'PONG'
        } catch {
            /* redis unavailable */
        }
        const allOk = dbOk && redisOk
        return {
            status: allOk ? 'ok' : 'degraded',
            timestamp: new Date().toISOString(),
            db: dbOk ? 'ok' : 'down',
            redis: redisOk ? 'ok' : 'down',
        }
    })

    // ── Readiness probe ──────────────────────────────────────────────────────
    app.get('/ready', async (_req, reply) => {
        try {
            const { sql: dbSql } = await import('./db/db')
            await dbSql`SELECT 1`
            const { redis } = await import('./queue/queues')
            await redis.ping()
            return { ready: true }
        } catch {
            reply.status(503)
            return { ready: false }
        }
    })

    // ── Connector API (Steps 8 + 9) ────────────────────────────────────────────
    await app.register(registerRoute)
    await app.register(heartbeatRoute)
    await app.register(configRoute)
    await app.register(jobsRoute)
    await app.register(resultRoute)
    await app.register(exceptionRoute)
    await app.register(syncDataRoute)

    // ── Webhook — ERPNext → Tally ──────────────────────────────────────────────
    await app.register(erpnextWebhookRoute)

    // ── Dashboard API ────────────────────────────────────────────────────────
    await app.register(dashboardRoutes)

    // ── WebSocket (Step 11) ────────────────────────────────────────────────────
    await app.register(websocketPlugin)

    return app
}
