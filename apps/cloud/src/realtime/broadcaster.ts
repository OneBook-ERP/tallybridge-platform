/**
 * Step 11 — In-process WebSocket event broadcaster.
 *
 * broadcaster.emit(companyId, eventType, data) fans out to all
 * dashboard clients subscribed to that company.
 *
 * The broadcaster is decoupled from the WebSocket transport — it uses
 * a simple EventEmitter internally. The WebSocket plugin (websocket.ts)
 * registers listeners and bridges them to actual sockets.
 *
 * Events defined in PRD:
 *   connector:status   — heartbeat result
 *   sync:progress      — batch in progress
 *   exception:new      — new exception recorded
 *   conflict:detected  — conflict found
 *   job:completed      — connector write result
 */
import { EventEmitter } from 'events'

export type BroadcastEvent =
    | 'connector:status'
    | 'sync:progress'
    | 'exception:new'
    | 'conflict:detected'
    | 'job:completed'

class Broadcaster extends EventEmitter {
    /**
     * Emit an event for a specific company.
     * All WebSocket clients subscribed to that company receive it.
     */
    emit(companyId: string, event: BroadcastEvent, data: Record<string, unknown>): boolean {
        return super.emit(`${companyId}:${event}`, data)
    }

    /**
     * Subscribe a callback to events for a specific company.
     * Returns the unsubscribe function — call it when the WebSocket closes.
     */
    subscribe(
        companyId: string,
        event: BroadcastEvent,
        handler: (data: Record<string, unknown>) => void
    ): () => void {
        const key = `${companyId}:${event}`
        this.on(key, handler)
        return () => this.off(key, handler)
    }
}

// Singleton — imported by any module that needs to broadcast.
export const broadcaster = new Broadcaster()
broadcaster.setMaxListeners(500) // allow many concurrent dashboard sessions
