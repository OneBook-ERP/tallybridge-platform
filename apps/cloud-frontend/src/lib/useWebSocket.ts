import { useEffect, useRef, useState, useCallback } from 'react'
import { connectWebSocket } from './api'

export interface UseWebSocketOptions {
  /** Company ID to scope the connection. */
  companyId: string
  /** Auto-reconnect after disconnect (default true). */
  reconnect?: boolean
  /** Delay in ms between reconnect attempts (default 3000). */
  reconnectDelay?: number
}

export interface UseWebSocketReturn<T = unknown> {
  /** The most recent parsed message from the server. */
  lastMessage: T | null
  /** All messages received since mount (capped at 200). */
  messages: T[]
  /** Current connection state. */
  readyState: number
  /** Send a JSON-serialisable payload to the server. */
  send: (data: unknown) => void
}

const MAX_MESSAGES = 200

export function useWebSocket<T = unknown>(
  options: UseWebSocketOptions,
): UseWebSocketReturn<T> {
  const { companyId, reconnect = true, reconnectDelay = 3000 } = options
  const wsRef = useRef<WebSocket | null>(null)
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const [lastMessage, setLastMessage] = useState<T | null>(null)
  const [messages, setMessages] = useState<T[]>([])
  const [readyState, setReadyState] = useState<number>(0) // WebSocket.CONNECTING

  const connect = useCallback(() => {
    const ws = connectWebSocket(companyId)
    wsRef.current = ws

    ws.addEventListener('open', () => setReadyState(ws.readyState))

    ws.addEventListener('message', (event) => {
      try {
        const data = JSON.parse(event.data) as T
        setLastMessage(data)
        setMessages((prev) => {
          const next = [...prev, data]
          return next.length > MAX_MESSAGES ? next.slice(-MAX_MESSAGES) : next
        })
      } catch {
        // non-JSON message — ignore
      }
    })

    ws.addEventListener('close', () => {
      setReadyState(ws.readyState)
      if (reconnect) {
        reconnectTimer.current = setTimeout(connect, reconnectDelay)
      }
    })

    ws.addEventListener('error', () => {
      ws.close()
    })
  }, [companyId, reconnect, reconnectDelay])

  useEffect(() => {
    connect()
    return () => {
      clearTimeout(reconnectTimer.current)
      wsRef.current?.close()
    }
  }, [connect])

  const send = useCallback((data: unknown) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(data))
    }
  }, [])

  return { lastMessage, messages, readyState, send }
}
