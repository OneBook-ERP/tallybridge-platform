/**
 * API client for the TallyBridge Cloud backend.
 *
 * In development, Vite proxies /api/* to http://localhost:3000 (stripping /api prefix).
 * In production, set VITE_API_BASE_URL to the backend origin.
 */

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? '/api'
const WS_BASE = import.meta.env.VITE_WS_BASE_URL ?? `ws://${window.location.host}/ws`

// ---------------------------------------------------------------------------
// Generic fetch helper
// ---------------------------------------------------------------------------

export async function apiFetch<T = unknown>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const url = `${API_BASE}${path}`
  const res = await fetch(url, {
    headers: {
      // Only set Content-Type when there is a body — Fastify rejects application/json with empty body
      ...(init?.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers,
    },
    ...init,
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`API ${res.status}: ${res.statusText} — ${body}`)
  }

  return res.json() as Promise<T>
}

// ---------------------------------------------------------------------------
// Endpoint helpers
// ---------------------------------------------------------------------------

/** Health check — GET /api/health (proxied to localhost:3000/health) */
export function fetchHealth() {
  return apiFetch<{ status: string }>('/health')
}

/** Sync records for a company (placeholder — endpoint TBD) */
export function fetchSyncRecords(companyId: string) {
  return apiFetch<unknown[]>(`/companies/${companyId}/sync-records`)
}

/** Exceptions for a company (placeholder — endpoint TBD) */
export function fetchExceptions(companyId: string) {
  return apiFetch<unknown[]>(`/companies/${companyId}/exceptions`)
}

// ---------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------

/** Open a WebSocket connection scoped to a company. */
export function connectWebSocket(companyId: string): WebSocket {
  const url = `${WS_BASE}?companyId=${encodeURIComponent(companyId)}`
  return new WebSocket(url)
}
