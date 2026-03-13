/**
 * Step 11 — Fastify WebSocket plugin.
 * Dashboard clients connect to: ws://host/ws?companyId=<uuid>
 *
 * @fastify/websocket v8: handler receives (connection: SocketStream, request)
 * connection.socket is the underlying ws.WebSocket — typed via @fastify/websocket's exports.
 */
import type { FastifyPluginAsync } from 'fastify'
import fastifyWebsocket, { type SocketStream } from '@fastify/websocket'
import { broadcaster, type BroadcastEvent } from './broadcaster'
import { logger } from '../lib/logger'

const ALL_EVENTS: BroadcastEvent[] = [
    'connector:status',
    'sync:progress',
    'exception:new',
    'conflict:detected',
    'job:completed',
]

export const websocketPlugin: FastifyPluginAsync = async (fastify) => {
    await fastify.register(fastifyWebsocket)

    fastify.get(
        '/ws',
        { websocket: true },
        (connection: SocketStream, request) => {
            const { socket } = connection // ws.WebSocket — has send/close/on/ping

            const rawUrl = request.url ?? ''
            const qs = rawUrl.includes('?') ? rawUrl.split('?')[1] : ''
            const params = new URLSearchParams(qs)
            const companyId = params.get('companyId')

            if (!companyId) {
                socket.send(JSON.stringify({ error: 'companyId query param is required' }))
                socket.close()
                return
            }

            logger.debug({ companyId }, 'Dashboard WebSocket connected')

            // Bridge broadcaster → socket for all PRD-defined events.
            const unsubscribers = ALL_EVENTS.map((event) =>
                broadcaster.subscribe(companyId, event, (data) => {
                    if (socket.readyState === socket.OPEN) {
                        socket.send(JSON.stringify({ event, data }))
                    }
                })
            )

            // 25s ping to keep alive through load balancers.
            const pingInterval = setInterval(() => {
                if (socket.readyState === socket.OPEN) socket.ping()
            }, 25_000)

            socket.on('close', () => {
                clearInterval(pingInterval)
                unsubscribers.forEach((fn) => fn())
                logger.debug({ companyId }, 'Dashboard WebSocket disconnected')
            })

            socket.on('message', (msg: unknown) => {
                logger.debug({ companyId, msg: String(msg) }, 'WS message from dashboard (ignored)')
            })
        }
    )
}
