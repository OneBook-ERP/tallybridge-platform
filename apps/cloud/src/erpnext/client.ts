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

    async listDocs<T = Record<string, unknown>>(
        doctype: string,
        filters: unknown[][],
        fields: string[],
        orderBy?: string,
        limit = 20,
    ): Promise<T[]> {
        const params = new URLSearchParams({
            filters: JSON.stringify(filters),
            fields: JSON.stringify(fields),
            limit_page_length: String(limit),
        })
        if (orderBy) params.set('order_by', orderBy)
        const results = await this.request<T[]>(
            'GET',
            `/api/resource/${encodeURIComponent(doctype)}?${params.toString()}`,
        )
        return results ?? []
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

    async deleteDoc(doctype: string, name: string): Promise<void> {
        await this.request('DELETE', `/api/resource/${encodeURIComponent(doctype)}/${encodeURIComponent(name)}`)
    }

    /** Ensure a Customer exists in ERPNext with correct GSTIN; create or update if needed. */
    async ensureCustomer(name: string, gstin?: string, customerGroup?: string): Promise<void> {
        let existing: { gstin?: string; gst_category?: string; customer_group?: string } | null = null
        try {
            existing = await this.getDoc<{ gstin?: string; gst_category?: string; customer_group?: string }>(
                'Customer',
                name,
            )
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
                return
            }
            throw err
        }
        const updates: Record<string, unknown> = {}
        if (gstin && !existing.gstin) {
            updates.gstin = gstin
            updates.gst_category = 'Registered Regular'
        }
        if (
            customerGroup &&
            existing.customer_group === 'All Customer Groups' &&
            customerGroup !== 'All Customer Groups'
        ) {
            updates.customer_group = customerGroup
        }
        if (Object.keys(updates).length > 0) {
            try {
                await this.updateDoc('Customer', name, updates)
                logger.info({ name, ...updates }, 'Updated Customer in ERPNext')
            } catch (err) {
                logger.warn({ name, updates, err }, 'Customer update failed — continuing with existing data')
            }
        }
    }

    /** Ensure a Supplier exists in ERPNext with correct GSTIN; create or update if needed. */
    async ensureSupplier(name: string, gstin?: string, supplierGroup?: string): Promise<void> {
        let existing: { gstin?: string; gst_category?: string; supplier_group?: string } | null = null
        try {
            existing = await this.getDoc<{ gstin?: string; gst_category?: string; supplier_group?: string }>(
                'Supplier',
                name,
            )
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
                return
            }
            throw err
        }
        const updates: Record<string, unknown> = {}
        if (gstin && !existing.gstin) {
            updates.gstin = gstin
            updates.gst_category = 'Registered Regular'
        }
        if (
            supplierGroup &&
            existing.supplier_group === 'All Supplier Groups' &&
            supplierGroup !== 'All Supplier Groups'
        ) {
            updates.supplier_group = supplierGroup
        }
        if (Object.keys(updates).length > 0) {
            try {
                await this.updateDoc('Supplier', name, updates)
                logger.info({ name, ...updates }, 'Updated Supplier in ERPNext')
            } catch (err) {
                logger.warn({ name, updates, err }, 'Supplier update failed — continuing with existing data')
            }
        }
    }

    /** Ensure a UOM exists in ERPNext; create if missing. */
    async ensureUOM(uom: string): Promise<void> {
        if (!uom || uom === 'Nos') return // 'Nos' always exists
        try {
            await this.getDoc('UOM', uom)
        } catch (err) {
            if (err instanceof ERPNextError && err.status === 404) {
                try {
                    await this.createDoc('UOM', { uom_name: uom, enabled: 1 })
                    logger.info({ uom }, 'Auto-created UOM in ERPNext')
                } catch (createErr) {
                    logger.warn({ uom, err: createErr }, 'Could not create UOM — will fall back to Nos')
                }
            }
        }
    }

    /** Ensure an Item Group exists in ERPNext under 'All Item Groups'; create if missing. */
    async ensureItemGroup(groupName: string): Promise<void> {
        if (!groupName || groupName === 'All Item Groups') return
        try {
            await this.getDoc('Item Group', groupName)
        } catch (err) {
            if (err instanceof ERPNextError && err.status === 404) {
                try {
                    await this.createDoc('Item Group', {
                        item_group_name: groupName,
                        parent_item_group: 'All Item Groups',
                        is_group: 0,
                    })
                    logger.info({ groupName }, 'Auto-created Item Group in ERPNext')
                } catch (createErr) {
                    logger.warn({ groupName, err: createErr }, 'Could not create Item Group — will fall back to All Item Groups')
                }
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
            const needsGroupUpdate =
                itemGroup && existing.item_group === 'All Item Groups' && itemGroup !== 'All Item Groups'
            if (needsHsnUpdate || needsGroupUpdate) {
                const updates: Record<string, unknown> = {}
                if (needsHsnUpdate) updates.gst_hsn_code = hsnCode
                if (needsGroupUpdate) updates.item_group = itemGroup
                await this.updateDoc('Item', itemCode, updates)
                logger.info({ itemCode, hsnCode, itemGroup }, 'Updated Item HSN/group in ERPNext')
            }
        } catch (err) {
            if (err instanceof ERPNextError && err.status === 404) {
                // Try with specific group/UOM; if that fails (group or UOM doesn't exist in ERPNext),
                // retry with safe defaults so the item always gets created.
                const baseDoc = {
                    doctype: 'Item',
                    item_code: itemCode,
                    item_name: itemCode,
                    is_stock_item: 1,
                    gst_hsn_code: hsnCode || '999111',
                }
                try {
                    await this.createDoc('Item', {
                        ...baseDoc,
                        item_group: itemGroup || 'All Item Groups',
                        stock_uom: uom || 'Nos',
                    })
                } catch {
                    // Fallback: safe defaults — also reset HSN in case original was invalid in India Compliance
                    await this.createDoc('Item', {
                        ...baseDoc,
                        gst_hsn_code: '999111',
                        item_group: 'All Item Groups',
                        stock_uom: 'Nos',
                    })
                }
                // Pre-create item prices so India Compliance doesn't throw on first SI/PI submit
                for (const priceList of ['Standard Selling', 'Standard Buying']) {
                    try {
                        await this.createDoc('Item Price', {
                            item_code: itemCode,
                            price_list: priceList,
                            price_list_rate: 0,
                            uom: uom || 'Nos',
                        })
                    } catch {
                        /* ignore — price may already exist */
                    }
                }
                logger.info({ itemCode }, 'Auto-created Item in ERPNext')
            }
        }
    }

    /**
     * Ensure a company billing address with GSTIN exists in ERPNext.
     * Returns the ERPNext Address name (e.g. "Covai Polymer Traders-Billing").
     */
    async ensureCompanyAddress(company: string, gstin: string, state?: string, city?: string): Promise<string> {
        // Search for existing company address with this GSTIN
        const results = await this.request<Array<{ name: string }>>(
            'GET',
            `/api/resource/Address?filters=${encodeURIComponent(
                JSON.stringify([
                    ['gstin', '=', gstin],
                    ['is_your_company_address', '=', 1],
                ]),
            )}&fields=["name"]&limit_page_length=1`,
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

    /**
     * Ensure a Bank GL Account exists under "Bank Accounts - {abbr}" in ERPNext's Chart of Accounts.
     * Used when syncing Tally bank/cash ledgers to ERPNext as proper GL accounts.
     * Returns the ERPNext account name (e.g. "HDFC Bank - CPT").
     */
    async ensureBankGLAccount(ledgerName: string, company: string, abbr: string): Promise<string> {
        const erpAccountName = `${ledgerName} - ${abbr}`
        try {
            await this.getDoc('Account', erpAccountName)
            return erpAccountName // already exists
        } catch (err) {
            if (!(err instanceof ERPNextError) || err.status !== 404) throw err
        }

        // Lookup actual Bank Accounts parent from ERPNext COA (may have a numeric prefix like "1200 - Bank Accounts - CPT")
        let parentAccount = `Bank Accounts - ${abbr}`
        try {
            const parents = await this.listDocs<{ name: string }>(
                'Account',
                [
                    ['is_group', '=', 1],
                    ['account_type', '=', 'Bank'],
                    ['company', '=', company],
                ],
                ['name'],
                undefined,
                1,
            )
            if (parents[0]?.name) parentAccount = parents[0].name
        } catch {
            /* fallback to default naming */
        }
        await this.createDoc('Account', {
            doctype: 'Account',
            account_name: ledgerName,
            parent_account: parentAccount,
            account_type: 'Bank',
            company,
        })
        logger.info({ ledgerName, erpAccountName }, 'Auto-created Bank GL Account in ERPNext')
        return erpAccountName
    }

    /**
     * Ensure a generic GL Account exists in ERPNext's Chart of Accounts.
     * Classifies by ledger name keywords: bank/FD → Bank, income/interest → Indirect Income,
     * everything else → Indirect Expenses.
     * Returns the ERPNext account name (e.g. "Interest Income - CPT").
     */
    async ensureGLAccount(ledgerName: string, company: string, abbr: string): Promise<string> {
        const erpAccountName = `${ledgerName} - ${abbr}`
        try {
            await this.getDoc('Account', erpAccountName)
            return erpAccountName // already exists
        } catch (err) {
            if (!(err instanceof ERPNextError) || err.status !== 404) throw err
        }

        const nameL = ledgerName.toLowerCase()
        let accountType = ''
        let parentAccount: string

        if (/bank|fd\b|fixed.?deposit/.test(nameL)) {
            accountType = 'Bank'
            try {
                const parents = await this.listDocs<{ name: string }>(
                    'Account',
                    [['is_group', '=', 1], ['account_type', '=', 'Bank'], ['company', '=', company]],
                    ['name'], undefined, 1,
                )
                parentAccount = parents[0]?.name ?? `Bank Accounts - ${abbr}`
            } catch {
                parentAccount = `Bank Accounts - ${abbr}`
            }
        } else if (/income|revenue|interest|dividend/.test(nameL)) {
            accountType = 'Income Account'
            parentAccount = `Indirect Income - ${abbr}`
        } else {
            parentAccount = `Indirect Expenses - ${abbr}`
        }

        try {
            await this.createDoc('Account', {
                doctype: 'Account',
                account_name: ledgerName,
                parent_account: parentAccount,
                account_type: accountType || undefined,
                company,
            })
        } catch {
            // Parent may not exist — try the other common root name format
            const fallbackParent = accountType === 'Income Account'
                ? `Indirect Income - ${abbr}`
                : `Indirect Expenses - ${abbr}`
            await this.createDoc('Account', {
                doctype: 'Account',
                account_name: ledgerName,
                parent_account: fallbackParent,
                company,
            })
        }
        logger.info({ ledgerName, erpAccountName }, 'Auto-created GL Account in ERPNext')
        return erpAccountName
    }

    /**
     * Create a one-time opening stock reconciliation in ERPNext for all Tally stock items
     * that have opening balances. Uses Stock Reconciliation (purpose=Opening Stock).
     * Idempotent: skips if a Stock Reconciliation with remarks "__OPENING_STOCK__" already exists.
     */
    async ensureOpeningStockEntry(
        items: Array<{ itemCode: string; qty: number; rate: number; uom?: string }>,
        company: string,
        warehouse: string,
        postingDate: string,
        _costCenter?: string,
    ): Promise<void> {
        // Check if opening stock reconciliation already exists for this company
        const existing = await this.listDocs<{ name: string }>(
            'Stock Reconciliation',
            [['purpose', '=', 'Opening Stock'], ['company', '=', company], ['docstatus', '=', 1]],
            ['name'],
            undefined,
            1,
        )
        if (existing.length > 0) {
            logger.info({ name: existing[0].name }, 'Opening stock reconciliation already exists — skipping')
            return
        }

        // Find Temporary Opening account for the difference account
        const tempAccounts = await this.listDocs<{ name: string }>(
            'Account',
            [['account_type', '=', 'Temporary'], ['company', '=', company]],
            ['name'],
            undefined,
            1,
        )
        const expenseAccount = tempAccounts[0]?.name
        if (!expenseAccount) {
            logger.warn({ company }, 'No Temporary Opening account found — skipping opening stock')
            return
        }

        // ERPNext requires valuation_rate > 0 for Opening Stock — skip 0-rate items
        const zeroRateItems = items.filter((i) => i.qty > 0 && !i.rate)
        if (zeroRateItems.length > 0) {
            logger.warn(
                { count: zeroRateItems.length, items: zeroRateItems.map((i) => i.itemCode) },
                'Skipping opening stock items with no valuation rate — resync connector after Tally returns opening values',
            )
        }
        const reconItems = items
            .filter((i) => i.qty > 0 && i.rate > 0)
            .map((i) => ({
                item_code: i.itemCode,
                warehouse,
                qty: i.qty,
                valuation_rate: i.rate,
            }))

        if (reconItems.length === 0) {
            logger.warn({ warehouse }, 'No items with valid valuation rate — opening stock reconciliation skipped')
            return
        }

        try {
            const created = await this.createDoc<{ name: string }>('Stock Reconciliation', {
                purpose: 'Opening Stock',
                posting_date: postingDate,
                company,
                expense_account: expenseAccount,
                items: reconItems,
                custom_sync_source: 'TALLYBRIDGE',
            })
            await this.submitDoc('Stock Reconciliation', created.name)
            logger.info({ name: created.name, itemCount: reconItems.length }, 'Opening stock reconciliation created')
        } catch (err) {
            logger.warn({ err }, 'Failed to create opening stock reconciliation — stock may go negative on first sync')
        }
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
