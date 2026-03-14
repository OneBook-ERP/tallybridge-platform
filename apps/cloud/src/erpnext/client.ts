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
    async ensureCustomer(name: string, gstin?: string, customerGroup?: string): Promise<void> {
        try {
            const existing = await this.getDoc<{ gstin?: string; gst_category?: string; customer_group?: string }>('Customer', name)
            const updates: Record<string, unknown> = {}
            if (gstin && !existing.gstin) {
                updates.gstin = gstin
                updates.gst_category = 'Registered Regular'
            }
            if (customerGroup && existing.customer_group === 'All Customer Groups' && customerGroup !== 'All Customer Groups') {
                updates.customer_group = customerGroup
            }
            if (Object.keys(updates).length > 0) {
                await this.updateDoc('Customer', name, updates)
                logger.info({ name, ...updates }, 'Updated Customer in ERPNext')
            }
        } catch (err) {
            if (err instanceof ERPNextError && err.status === 404) {
                await this.createDoc('Customer', {
                    doctype: 'Customer',
                    customer_name: name,
                    customer_type: 'Company',
                    customer_group: customerGroup || 'All Customer Groups',
                    territory: 'All Territories',
                    gstin: gstin || undefined,
                    gst_category: gstin ? 'Registered Regular' : 'Unregistered',
                })
                logger.info({ name }, 'Auto-created Customer in ERPNext')
            }
        }
    }

    /** Ensure a Supplier exists in ERPNext with correct GSTIN; create or update if needed. */
    async ensureSupplier(name: string, gstin?: string, supplierGroup?: string): Promise<void> {
        try {
            const existing = await this.getDoc<{ gstin?: string; gst_category?: string; supplier_group?: string }>('Supplier', name)
            const updates: Record<string, unknown> = {}
            if (gstin && !existing.gstin) {
                updates.gstin = gstin
                updates.gst_category = 'Registered Regular'
            }
            if (supplierGroup && existing.supplier_group === 'All Supplier Groups' && supplierGroup !== 'All Supplier Groups') {
                updates.supplier_group = supplierGroup
            }
            if (Object.keys(updates).length > 0) {
                await this.updateDoc('Supplier', name, updates)
                logger.info({ name, ...updates }, 'Updated Supplier in ERPNext')
            }
        } catch (err) {
            if (err instanceof ERPNextError && err.status === 404) {
                await this.createDoc('Supplier', {
                    doctype: 'Supplier',
                    supplier_name: name,
                    supplier_type: 'Company',
                    supplier_group: supplierGroup || 'All Supplier Groups',
                    gstin: gstin || undefined,
                    gst_category: gstin ? 'Registered Regular' : 'Unregistered',
                })
                logger.info({ name }, 'Auto-created Supplier in ERPNext')
            }
        }
    }

    /** Ensure an Item exists in ERPNext; create if missing. Update HSN if Tally provides a real one. */
    async ensureItem(itemCode: string, uom?: string, hsnCode?: string, itemGroup?: string): Promise<void> {
        try {
            const existing = await this.getDoc<{ gst_hsn_code?: string; item_group?: string }>('Item', itemCode)
            // Update HSN if Tally provides a real one and item has fallback SAC
            const hasRealHsn = hsnCode && hsnCode !== '999111' && hsnCode.length >= 4
            const needsHsnUpdate = hasRealHsn && (!existing.gst_hsn_code || existing.gst_hsn_code === '999111')
            const needsGroupUpdate = itemGroup && existing.item_group === 'All Item Groups' && itemGroup !== 'All Item Groups'
            if (needsHsnUpdate || needsGroupUpdate) {
                const updates: Record<string, unknown> = {}
                if (needsHsnUpdate) updates.gst_hsn_code = hsnCode
                if (needsGroupUpdate) updates.item_group = itemGroup
                await this.updateDoc('Item', itemCode, updates)
                logger.info({ itemCode, hsnCode, itemGroup }, 'Updated Item HSN/group in ERPNext')
            }
        } catch (err) {
            if (err instanceof ERPNextError && err.status === 404) {
                await this.createDoc('Item', {
                    doctype: 'Item',
                    item_code: itemCode,
                    item_name: itemCode,
                    item_group: itemGroup || 'All Item Groups',
                    stock_uom: uom || 'Nos',
                    is_stock_item: 1,
                    gst_hsn_code: hsnCode || '999111', // fallback SAC — India Compliance requires 6+ digit HSN
                })
                logger.info({ itemCode }, 'Auto-created Item in ERPNext')
            }
        }
    }

    /**
     * Ensure a company billing address with GSTIN exists in ERPNext.
     * Returns the ERPNext Address name (e.g. "Covai Polymer Traders-Billing").
     */
    async ensureCompanyAddress(
        company: string,
        gstin: string,
        state?: string,
        city?: string,
    ): Promise<string> {
        // Search for existing company address with this GSTIN
        const results = await this.request<Array<{ name: string }>>(
            'GET',
            `/api/resource/Address?filters=${encodeURIComponent(JSON.stringify([['gstin', '=', gstin], ['is_your_company_address', '=', 1]]))}&fields=["name"]&limit_page_length=1`,
        )
        if (results.length > 0) {
            return results[0].name
        }

        // Derive state from GSTIN code if not provided
        const stateCode = gstin.slice(0, 2)
        const stateMap: Record<string, { state: string; city: string }> = {
            '33': { state: 'Tamil Nadu', city: 'Coimbatore' },
            '27': { state: 'Maharashtra', city: 'Mumbai' },
            '29': { state: 'Karnataka', city: 'Bengaluru' },
            '07': { state: 'Delhi', city: 'New Delhi' },
            '36': { state: 'Telangana', city: 'Hyderabad' },
            '06': { state: 'Haryana', city: 'Gurugram' },
            '09': { state: 'Uttar Pradesh', city: 'Lucknow' },
            '19': { state: 'West Bengal', city: 'Kolkata' },
            '24': { state: 'Gujarat', city: 'Ahmedabad' },
            '32': { state: 'Kerala', city: 'Kochi' },
        }
        const derived = stateMap[stateCode]
        const addrState = state || derived?.state || ''
        const addrCity = city || derived?.city || 'City'

        const created = await this.createDoc<{ name: string }>('Address', {
            doctype: 'Address',
            address_title: company,
            address_type: 'Billing',
            address_line1: addrCity,
            city: addrCity,
            state: addrState,
            country: 'India',
            pincode: '000000',
            gstin,
            gst_category: 'Registered Regular',
            is_your_company_address: 1,
            links: [{ link_doctype: 'Company', link_name: company }],
        })
        logger.info({ company, gstin, addressName: created.name }, 'Auto-created company billing address')
        return created.name
    }

    /**
     * Ensure a party (Customer/Supplier) has an Address record in ERPNext.
     * Creates one if missing, using data from Tally ledger master.
     */
    async ensurePartyAddress(
        partyType: 'Customer' | 'Supplier',
        partyName: string,
        address: { lines?: string[]; pinCode?: string; state?: string; country?: string; gstin?: string },
    ): Promise<string | null> {
        if (!address.lines?.length && !address.pinCode) return null

        // Check if address already exists for this party
        const results = await this.request<Array<{ name: string }>>(
            'GET',
            `/api/resource/Address?filters=${encodeURIComponent(
                JSON.stringify([
                    ['Dynamic Link', 'link_doctype', '=', partyType],
                    ['Dynamic Link', 'link_name', '=', partyName],
                    ['address_type', '=', 'Billing'],
                ]),
            )}&fields=["name"]&limit_page_length=1`,
        )
        if (results.length > 0) return results[0].name

        // Build address from Tally data
        const lines = address.lines ?? []
        const line1 = lines[0] || partyName
        const line2 = lines.slice(1).join(', ') || undefined

        try {
            const created = await this.createDoc<{ name: string }>('Address', {
                doctype: 'Address',
                address_title: partyName,
                address_type: 'Billing',
                address_line1: line1,
                address_line2: line2,
                city: this.extractCity(lines, address.state) || 'City',
                state: address.state || undefined,
                country: address.country || 'India',
                pincode: address.pinCode || undefined,
                gstin: address.gstin || undefined,
                gst_category: address.gstin ? 'Registered Regular' : 'Unregistered',
                links: [{ link_doctype: partyType, link_name: partyName }],
            })
            logger.info({ partyType, partyName, addressName: created.name }, 'Auto-created party address')
            return created.name
        } catch (err) {
            logger.warn({ partyType, partyName, err }, 'Failed to create party address')
            return null
        }
    }

    /**
     * Ensure a party has a Contact record in ERPNext with email/phone.
     */
    async ensurePartyContact(
        partyType: 'Customer' | 'Supplier',
        partyName: string,
        contact: { email?: string; mobile?: string; phone?: string },
    ): Promise<string | null> {
        if (!contact.email && !contact.mobile && !contact.phone) return null

        // Check if contact already exists
        const results = await this.request<Array<{ name: string }>>(
            'GET',
            `/api/resource/Contact?filters=${encodeURIComponent(
                JSON.stringify([
                    ['Dynamic Link', 'link_doctype', '=', partyType],
                    ['Dynamic Link', 'link_name', '=', partyName],
                ]),
            )}&fields=["name"]&limit_page_length=1`,
        )
        if (results.length > 0) return results[0].name

        try {
            const doc: Record<string, unknown> = {
                doctype: 'Contact',
                first_name: partyName,
                is_primary_contact: 1,
                links: [{ link_doctype: partyType, link_name: partyName }],
            }
            if (contact.email) {
                doc.email_ids = [{ email_id: contact.email, is_primary: 1 }]
            }
            if (contact.mobile) {
                doc.phone_nos = [{ phone: contact.mobile, is_primary_mobile_no: 1 }]
            } else if (contact.phone) {
                doc.phone_nos = [{ phone: contact.phone, is_primary_phone: 1 }]
            }

            const created = await this.createDoc<{ name: string }>('Contact', doc)
            logger.info({ partyType, partyName, contactName: created.name }, 'Auto-created party contact')
            return created.name
        } catch (err) {
            logger.warn({ partyType, partyName, err }, 'Failed to create party contact')
            return null
        }
    }

    /** Extract a city name from address lines — heuristic: last line often contains city + pin */
    private extractCity(lines: string[], state?: string): string {
        if (lines.length === 0) return ''
        // Try the last line: often "COIMBATORE - 641035" or just "CHENNAI"
        const lastLine = lines[lines.length - 1].replace(/[-–]\s*\d{6}\s*$/, '').trim()
        if (lastLine.length > 2 && lastLine.length < 50) return lastLine
        // Fall back to state capital or empty
        return state || ''
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
