/**
 * Step 16 — ERPNext REST API client.
 * Uses API Key + Secret (token auth). All requests include custom_sync_source
 * on writes so the Frappe hook ignores them (loop guard).
 */
import { env } from '../lib/env'
import { logger } from '../lib/logger'

type HTTPMethod = 'GET' | 'POST' | 'PUT' | 'DELETE'

export interface ERPNextClientOptions {
    baseUrl?: string
    apiKey?: string
    apiSecret?: string
}

export class ERPNextClient {
    private readonly baseUrl: string
    private readonly authHeader: string

    constructor(opts: ERPNextClientOptions = {}) {
        this.baseUrl = (opts.baseUrl ?? env.ERPNEXT_URL ?? '').replace(/\/$/, '')
        const key = opts.apiKey ?? env.ERPNEXT_API_KEY ?? ''
        const secret = opts.apiSecret ?? env.ERPNEXT_API_SECRET ?? ''
        this.authHeader = `token ${key}:${secret}`
    }

    private async request<T>(method: HTTPMethod, path: string, body?: unknown, retries = 3): Promise<T> {
        const url = `${this.baseUrl}${path}`
        const init: RequestInit = {
            method,
            headers: {
                Authorization: this.authHeader,
                'Content-Type': 'application/json',
            },
            body: body ? JSON.stringify(body) : undefined,
        }

        for (let attempt = 1; attempt <= retries; attempt++) {
            const res = await fetch(url, init)

            // Handle rate limiting (PRD 4.5)
            if (res.status === 429) {
                const wait = Math.pow(2, attempt) * 1000
                logger.warn({ url, attempt, wait }, 'ERPNext rate limit — backing off')
                await delay(wait)
                continue
            }

            const json = (await res.json()) as { data?: T; message?: string; exc?: string; _server_messages?: string }

            if (!res.ok) {
                // ERPNext puts errors in _server_messages as a JSON-encoded array of JSON strings
                let errMsg = json.message ?? json.exc ?? 'Unknown error'
                if (json._server_messages) {
                    try {
                        const msgs = JSON.parse(json._server_messages) as string[]
                        const parsed = msgs.map((m) => {
                            try {
                                return JSON.parse(m)
                            } catch {
                                return { message: m }
                            }
                        })
                        errMsg =
                            parsed
                                .map((p: { message?: string }) => p.message)
                                .filter(Boolean)
                                .join('; ') || errMsg
                    } catch {
                        /* keep original errMsg */
                    }
                }
                throw new ERPNextError(res.status, errMsg, url)
            }
            return json.data as T
        }
        throw new ERPNextError(429, 'Rate limit exceeded after retries', url)
    }

    // ── Read operations ──────────────────────────────────────────────────────────

    async getDoc<T = Record<string, unknown>>(doctype: string, name: string): Promise<T> {
        return this.request<T>('GET', `/api/resource/${encodeURIComponent(doctype)}/${encodeURIComponent(name)}`)
    }

    async findByTallyGUID(doctype: string, guid: string): Promise<string | null> {
        // request() extracts json.data, so result is the array directly
        const results = await this.request<Array<{ name: string }>>(
            'GET',
            `/api/resource/${encodeURIComponent(doctype)}?filters=[["custom_tally_guid","=","${guid}"]]&fields=["name"]&limit_page_length=1`,
        )
        return (results as Array<{ name: string }>)?.[0]?.name ?? null
    }

    // ── Write operations ────────────────────────────────────────────────────────

    async createDoc<T>(doctype: string, doc: Record<string, unknown>): Promise<T> {
        return this.request<T>('POST', `/api/resource/${encodeURIComponent(doctype)}`, {
            ...doc,
            custom_sync_source: 'TALLYBRIDGE', // loop guard
        })
    }

    async updateDoc<T>(doctype: string, name: string, fields: Record<string, unknown>): Promise<T> {
        return this.request<T>('PUT', `/api/resource/${encodeURIComponent(doctype)}/${encodeURIComponent(name)}`, {
            ...fields,
            custom_sync_source: 'TALLYBRIDGE',
        })
    }

    /** ERPNext cancel-amend pattern for updating submitted docs (PRD 6.3) */
    async cancelAndAmend(doctype: string, name: string, updates: Record<string, unknown>): Promise<string> {
        // 1. Cancel the original
        await this.request('POST', `/api/method/frappe.client.cancel`, { doctype, name })
        // 2. Amend — creates a new doc linked via amended_from
        const amended = await this.request<{ name: string }>('POST', `/api/method/frappe.client.amend_doc`, {
            doctype,
            name,
        })
        const amendedName = amended.name
        // 3. Apply updates and submit
        await this.updateDoc(doctype, amendedName, updates)
        await this.submitDoc(doctype, amendedName)
        return amendedName
    }

    async submitDoc(doctype: string, name: string): Promise<void> {
        await this.request('PUT', `/api/resource/${encodeURIComponent(doctype)}/${encodeURIComponent(name)}`, {
            docstatus: 1,
            custom_sync_source: 'TALLYBRIDGE',
        })
    }

    /** Ensure a Customer exists in ERPNext with correct GSTIN; create or update if needed. */
    async ensureCustomer(name: string, gstin?: string): Promise<void> {
        try {
            const existing = await this.getDoc<{ gstin?: string; gst_category?: string }>('Customer', name)
            // Update GSTIN if customer exists but doesn't have it set
            if (gstin && !existing.gstin) {
                await this.updateDoc('Customer', name, {
                    gstin,
                    gst_category: 'Registered Regular',
                })
                logger.info({ name }, 'Updated Customer GSTIN in ERPNext')
            }
        } catch (err) {
            if (err instanceof ERPNextError && err.status === 404) {
                await this.createDoc('Customer', {
                    doctype: 'Customer',
                    customer_name: name,
                    customer_type: 'Company',
                    customer_group: 'All Customer Groups',
                    territory: 'All Territories',
                    gstin: gstin || undefined,
                    gst_category: gstin ? 'Registered Regular' : 'Unregistered',
                })
                logger.info({ name }, 'Auto-created Customer in ERPNext')
            }
        }
    }

    /** Ensure a Supplier exists in ERPNext with correct GSTIN; create or update if needed. */
    async ensureSupplier(name: string, gstin?: string): Promise<void> {
        try {
            const existing = await this.getDoc<{ gstin?: string; gst_category?: string }>('Supplier', name)
            if (gstin && !existing.gstin) {
                await this.updateDoc('Supplier', name, {
                    gstin,
                    gst_category: 'Registered Regular',
                })
                logger.info({ name }, 'Updated Supplier GSTIN in ERPNext')
            }
        } catch (err) {
            if (err instanceof ERPNextError && err.status === 404) {
                await this.createDoc('Supplier', {
                    doctype: 'Supplier',
                    supplier_name: name,
                    supplier_type: 'Company',
                    supplier_group: 'All Supplier Groups',
                    gstin: gstin || undefined,
                    gst_category: gstin ? 'Registered Regular' : 'Unregistered',
                })
                logger.info({ name }, 'Auto-created Supplier in ERPNext')
            }
        }
    }

    /** Ensure an Item exists in ERPNext; create if missing. */
    async ensureItem(itemCode: string, uom?: string, hsnCode?: string): Promise<void> {
        try {
            await this.getDoc('Item', itemCode)
        } catch (err) {
            if (err instanceof ERPNextError && err.status === 404) {
                await this.createDoc('Item', {
                    doctype: 'Item',
                    item_code: itemCode,
                    item_name: itemCode,
                    item_group: 'All Item Groups',
                    stock_uom: uom || 'Nos',
                    is_stock_item: 1,
                    gst_hsn_code: hsnCode || '999111', // fallback SAC — India Compliance requires 6+ digit HSN
                })
                logger.info({ itemCode }, 'Auto-created Item in ERPNext')
            }
        }
    }

    /** Count documents of a given doctype, optionally filtered. */
    async countDocs(doctype: string, filters?: string[][]): Promise<number> {
        const params = new URLSearchParams({ doctype })
        if (filters && filters.length > 0) {
            params.set('filters', JSON.stringify(filters))
        }
        const url = `${this.baseUrl}/api/method/frappe.client.get_count?${params.toString()}`
        const res = await fetch(url, {
            headers: { Authorization: this.authHeader },
        })
        if (!res.ok) return 0
        const json = (await res.json()) as { message?: number }
        return json.message ?? 0
    }

    async patchSyncStatus(doctype: string, name: string, status: 'Synced' | 'Pending' | 'Error'): Promise<void> {
        await this.request('PUT', `/api/resource/${encodeURIComponent(doctype)}/${encodeURIComponent(name)}`, {
            custom_tally_sync_status: status,
        })
    }
}

export class ERPNextError extends Error {
    constructor(
        public readonly status: number,
        message: string,
        public readonly url: string,
    ) {
        super(message)
        this.name = 'ERPNextError'
    }
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
}

// Default singleton — used by the sync engine.
export const erpClient = new ERPNextClient()
