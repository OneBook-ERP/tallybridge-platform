/**
 * Group 1: Master Data — ERPNextClient ensure* methods
 *
 * Covers: ensureCustomer, ensureSupplier, ensureUOM, ensureItemGroup,
 *         ensureItem, ensurePartyAddress, ensurePartyContact,
 *         ensureCompanyAddress, cancelAndAmend
 *
 * All HTTP calls are intercepted via the global fetch mock.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ERPNextClient, ERPNextError } from './client'

// ── Mock global fetch ────────────────────────────────────────────────────────

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

function ok(data: unknown, status = 200) {
    return Promise.resolve({
        ok: true,
        status,
        json: async () => ({ data }),
    })
}

function notFound() {
    return Promise.resolve({
        ok: false,
        status: 404,
        json: async () => ({ message: 'Not found', _server_messages: undefined }),
    })
}

function serverError(msg: string, status = 417) {
    return Promise.resolve({
        ok: false,
        status,
        json: async () => ({ message: msg }),
    })
}

// ── Helpers ──────────────────────────────────────────────────────────────────

let client: ERPNextClient

beforeEach(() => {
    vi.clearAllMocks()
    client = new ERPNextClient({ baseUrl: 'https://erp.example.com', apiKey: 'k', apiSecret: 's' })
})

// ── ensureCustomer ───────────────────────────────────────────────────────────

describe('ensureCustomer', () => {
    it('creates a new customer when not found (404)', async () => {
        mockFetch
            .mockReturnValueOnce(notFound()) // GET Customer — not found
            .mockReturnValueOnce(ok({ name: 'New Customer' })) // POST Customer — created

        await client.ensureCustomer('New Customer', '33AABCC1234D1ZA', 'Commercial')

        const [, createCall] = mockFetch.mock.calls
        const body = JSON.parse(createCall[1].body)
        expect(body.customer_name).toBe('New Customer')
        expect(body.gstin).toBe('33AABCC1234D1ZA')
        expect(body.gst_category).toBe('Registered Regular')
        expect(body.customer_group).toBe('Commercial')
    })

    it('creates customer as Unregistered when no GSTIN', async () => {
        mockFetch.mockReturnValueOnce(notFound()).mockReturnValueOnce(ok({ name: 'Walk-in Customer' }))

        await client.ensureCustomer('Walk-in Customer')

        const body = JSON.parse(mockFetch.mock.calls[1][1].body)
        expect(body.gst_category).toBe('Unregistered')
        expect(body.gstin).toBeUndefined()
    })

    it('updates GSTIN on existing customer that has none', async () => {
        mockFetch
            .mockReturnValueOnce(
                ok({
                    name: 'ABC Corp',
                    gstin: null,
                    gst_category: 'Unregistered',
                    customer_group: 'All Customer Groups',
                }),
            ) // GET
            .mockReturnValueOnce(ok({ name: 'ABC Corp' })) // PUT update

        await client.ensureCustomer('ABC Corp', '29AABCC9999D1ZA')

        const [, updateCall] = mockFetch.mock.calls
        expect(updateCall[0]).toContain('/Customer/ABC%20Corp')
        const body = JSON.parse(updateCall[1].body)
        expect(body.gstin).toBe('29AABCC9999D1ZA')
        expect(body.gst_category).toBe('Registered Regular')
    })

    it('updates customer_group when existing is default', async () => {
        mockFetch
            .mockReturnValueOnce(
                ok({ name: 'XYZ Ltd', gstin: '33AABCC0000D1ZA', customer_group: 'All Customer Groups' }),
            )
            .mockReturnValueOnce(ok({ name: 'XYZ Ltd' }))

        await client.ensureCustomer('XYZ Ltd', '33AABCC0000D1ZA', 'Commercial')

        const body = JSON.parse(mockFetch.mock.calls[1][1].body)
        expect(body.customer_group).toBe('Commercial')
    })

    it('does NOT update when customer already has GSTIN and specific group', async () => {
        mockFetch.mockReturnValueOnce(
            ok({
                name: 'Old Customer',
                gstin: '33AABCC1111D1ZA',
                gst_category: 'Registered Regular',
                customer_group: 'Commercial',
            }),
        )

        await client.ensureCustomer('Old Customer', '33AABCC1111D1ZA', 'Commercial')

        // Only one call (GET) — no update
        expect(mockFetch).toHaveBeenCalledTimes(1)
    })

    it('re-throws non-404 errors from GET', async () => {
        mockFetch.mockReturnValueOnce(serverError('Server error', 500))

        await expect(client.ensureCustomer('Bad Customer')).rejects.toBeInstanceOf(ERPNextError)
    })

    it('silently continues if update fails', async () => {
        mockFetch
            .mockReturnValueOnce(ok({ name: 'Tricky', gstin: null, customer_group: 'All Customer Groups' }))
            .mockReturnValueOnce(serverError('Permission denied', 403))

        // Should not throw even when update fails
        await expect(client.ensureCustomer('Tricky', '33AABCC2222D1ZA')).resolves.toBeUndefined()
    })
})

// ── ensureSupplier ───────────────────────────────────────────────────────────

describe('ensureSupplier', () => {
    it('creates a new supplier when not found', async () => {
        mockFetch.mockReturnValueOnce(notFound()).mockReturnValueOnce(ok({ name: 'New Supplier' }))

        await client.ensureSupplier('New Supplier', '27AABCS5678E1ZB', 'Services')

        const body = JSON.parse(mockFetch.mock.calls[1][1].body)
        expect(body.supplier_name).toBe('New Supplier')
        expect(body.gstin).toBe('27AABCS5678E1ZB')
        expect(body.gst_category).toBe('Registered Regular')
        expect(body.supplier_group).toBe('Services')
    })

    it('creates supplier as Unregistered when no GSTIN', async () => {
        mockFetch.mockReturnValueOnce(notFound()).mockReturnValueOnce(ok({ name: 'Cash Supplier' }))

        await client.ensureSupplier('Cash Supplier')

        const body = JSON.parse(mockFetch.mock.calls[1][1].body)
        expect(body.gst_category).toBe('Unregistered')
    })

    it('updates GSTIN on existing supplier that has none', async () => {
        mockFetch
            .mockReturnValueOnce(ok({ name: 'Old Vendor', gstin: null, supplier_group: 'All Supplier Groups' }))
            .mockReturnValueOnce(ok({ name: 'Old Vendor' }))

        await client.ensureSupplier('Old Vendor', '27AABCS1234F1ZC')

        const body = JSON.parse(mockFetch.mock.calls[1][1].body)
        expect(body.gstin).toBe('27AABCS1234F1ZC')
    })

    it('skips update when nothing changed', async () => {
        mockFetch.mockReturnValueOnce(
            ok({
                name: 'Stable Vendor',
                gstin: '27AABCS9999F1ZD',
                supplier_group: 'Services',
            }),
        )

        await client.ensureSupplier('Stable Vendor', '27AABCS9999F1ZD', 'Services')

        expect(mockFetch).toHaveBeenCalledTimes(1)
    })
})

// ── ensureUOM ────────────────────────────────────────────────────────────────

describe('ensureUOM', () => {
    it('skips lookup for "Nos" (always exists)', async () => {
        await client.ensureUOM('Nos')
        expect(mockFetch).not.toHaveBeenCalled()
    })

    it('skips lookup for empty string', async () => {
        await client.ensureUOM('')
        expect(mockFetch).not.toHaveBeenCalled()
    })

    it('does nothing when UOM already exists', async () => {
        mockFetch.mockReturnValueOnce(ok({ uom_name: 'Kg' }))

        await client.ensureUOM('Kg')
        expect(mockFetch).toHaveBeenCalledTimes(1)
        expect(mockFetch.mock.calls[0][0]).toContain('/UOM/Kg')
    })

    it('creates UOM when not found', async () => {
        mockFetch.mockReturnValueOnce(notFound()).mockReturnValueOnce(ok({ uom_name: 'Litre' }))

        await client.ensureUOM('Litre')

        const body = JSON.parse(mockFetch.mock.calls[1][1].body)
        expect(body.uom_name).toBe('Litre')
        expect(body.enabled).toBe(1)
    })

    it('silently continues when UOM creation fails', async () => {
        mockFetch.mockReturnValueOnce(notFound()).mockReturnValueOnce(serverError('Duplicate', 409))

        await expect(client.ensureUOM('Bag')).resolves.toBeUndefined()
    })
})

// ── ensureItemGroup ──────────────────────────────────────────────────────────

describe('ensureItemGroup', () => {
    it('skips when group is "All Item Groups"', async () => {
        await client.ensureItemGroup('All Item Groups')
        expect(mockFetch).not.toHaveBeenCalled()
    })

    it('skips when group name is empty', async () => {
        await client.ensureItemGroup('')
        expect(mockFetch).not.toHaveBeenCalled()
    })

    it('does nothing when group already exists', async () => {
        mockFetch.mockReturnValueOnce(ok({ item_group_name: 'Polymers' }))

        await client.ensureItemGroup('Polymers')
        expect(mockFetch).toHaveBeenCalledTimes(1)
    })

    it('creates group under All Item Groups when not found', async () => {
        mockFetch.mockReturnValueOnce(notFound()).mockReturnValueOnce(ok({ item_group_name: 'Raw Material' }))

        await client.ensureItemGroup('Raw Material')

        const body = JSON.parse(mockFetch.mock.calls[1][1].body)
        expect(body.item_group_name).toBe('Raw Material')
        expect(body.parent_item_group).toBe('All Item Groups')
        expect(body.is_group).toBe(0)
    })

    it('silently continues when group creation fails', async () => {
        mockFetch.mockReturnValueOnce(notFound()).mockReturnValueOnce(serverError('Validation error', 422))

        await expect(client.ensureItemGroup('Broken Group')).resolves.toBeUndefined()
    })
})

// ── ensureItem ───────────────────────────────────────────────────────────────

describe('ensureItem', () => {
    it('creates a new item with HSN, UOM, and group when not found', async () => {
        mockFetch
            .mockReturnValueOnce(notFound()) // GET Item
            .mockReturnValueOnce(ok({ name: 'Widget A' })) // POST Item
            .mockReturnValueOnce(ok({ name: 'IP-001' })) // POST Item Price (Selling)
            .mockReturnValueOnce(ok({ name: 'IP-002' })) // POST Item Price (Buying)

        await client.ensureItem('Widget A', 'Nos', '84719000', 'Products')

        const createBody = JSON.parse(mockFetch.mock.calls[1][1].body)
        expect(createBody.item_code).toBe('Widget A')
        expect(createBody.gst_hsn_code).toBe('84719000')
        expect(createBody.item_group).toBe('Products')
        expect(createBody.stock_uom).toBe('Nos')
        expect(createBody.is_stock_item).toBe(1)
    })

    it('uses fallback HSN 999111 when no HSN provided', async () => {
        mockFetch
            .mockReturnValueOnce(notFound())
            .mockReturnValueOnce(ok({ name: 'Service Item' }))
            .mockReturnValueOnce(ok({}))
            .mockReturnValueOnce(ok({}))

        await client.ensureItem('Service Item', 'Nos', '', 'Services')

        const createBody = JSON.parse(mockFetch.mock.calls[1][1].body)
        expect(createBody.gst_hsn_code).toBe('999111')
    })

    it('updates HSN on existing item with fallback SAC', async () => {
        mockFetch
            .mockReturnValueOnce(ok({ gst_hsn_code: '999111', item_group: 'All Item Groups' })) // GET
            .mockReturnValueOnce(ok({ name: 'Pipe A' })) // PUT update

        await client.ensureItem('Pipe A', 'Nos', '391729000', 'Products')

        const updateBody = JSON.parse(mockFetch.mock.calls[1][1].body)
        expect(updateBody.gst_hsn_code).toBe('391729000')
    })

    it('updates item_group when existing is default', async () => {
        mockFetch
            .mockReturnValueOnce(ok({ gst_hsn_code: '391729000', item_group: 'All Item Groups' }))
            .mockReturnValueOnce(ok({}))

        await client.ensureItem('Pipe B', 'Nos', '391729000', 'Raw Material')

        const updateBody = JSON.parse(mockFetch.mock.calls[1][1].body)
        expect(updateBody.item_group).toBe('Raw Material')
    })

    it('does NOT update when item HSN is already correct', async () => {
        mockFetch.mockReturnValueOnce(ok({ gst_hsn_code: '84719000', item_group: 'Products' }))

        await client.ensureItem('Widget Z', 'Nos', '84719000', 'Products')

        // Only the GET call
        expect(mockFetch).toHaveBeenCalledTimes(1)
    })

    it('retries item creation with safe defaults if first attempt fails', async () => {
        mockFetch
            .mockReturnValueOnce(notFound()) // GET
            .mockReturnValueOnce(serverError('Invalid group', 422)) // POST #1 — fails
            .mockReturnValueOnce(ok({ name: 'Fallback Item' })) // POST #2 — fallback
            .mockReturnValueOnce(ok({}))
            .mockReturnValueOnce(ok({})) // Item Prices

        await client.ensureItem('Fallback Item', 'Litre', '12345678', 'NonExistentGroup')

        // Third call is the fallback create
        const fallbackBody = JSON.parse(mockFetch.mock.calls[2][1].body)
        expect(fallbackBody.item_group).toBe('All Item Groups')
        expect(fallbackBody.stock_uom).toBe('Nos')
        expect(fallbackBody.gst_hsn_code).toBe('999111')
    })

    it('creates item prices for Standard Selling and Standard Buying', async () => {
        mockFetch
            .mockReturnValueOnce(notFound())
            .mockReturnValueOnce(ok({ name: 'New Item' }))
            .mockReturnValueOnce(ok({ name: 'IP-S' })) // Standard Selling
            .mockReturnValueOnce(ok({ name: 'IP-B' })) // Standard Buying

        await client.ensureItem('New Item', 'Nos', '12340000')

        // calls 2 and 3 should be Item Price creates
        const sellCall = JSON.parse(mockFetch.mock.calls[2][1].body)
        const buyCall = JSON.parse(mockFetch.mock.calls[3][1].body)
        expect(sellCall.price_list).toBe('Standard Selling')
        expect(buyCall.price_list).toBe('Standard Buying')
    })
})

// ── ensurePartyAddress ───────────────────────────────────────────────────────

describe('ensurePartyAddress', () => {
    it('returns null when no address data provided', async () => {
        const result = await client.ensurePartyAddress('Customer', 'ABC Corp', {})
        expect(result).toBeNull()
        expect(mockFetch).not.toHaveBeenCalled()
    })

    it('returns existing address name if already created', async () => {
        mockFetch.mockReturnValueOnce(ok([{ name: 'ABC Corp-Billing' }]))

        const result = await client.ensurePartyAddress('Customer', 'ABC Corp', {
            lines: ['123 Main St'],
            pinCode: '641035',
        })

        expect(result).toBe('ABC Corp-Billing')
        expect(mockFetch).toHaveBeenCalledTimes(1)
    })

    it('creates a new billing address when none exists', async () => {
        mockFetch
            .mockReturnValueOnce(ok([])) // search — not found
            .mockReturnValueOnce(ok({ name: 'XYZ Ltd-Billing' })) // POST create

        const result = await client.ensurePartyAddress('Customer', 'XYZ Ltd', {
            lines: ['Plot 5', 'Industrial Area', 'Coimbatore'],
            pinCode: '641035',
            state: 'Tamil Nadu',
            country: 'India',
            gstin: '33AABCC1234D1ZA',
        })

        expect(result).toBe('XYZ Ltd-Billing')

        const body = JSON.parse(mockFetch.mock.calls[1][1].body)
        expect(body.address_line1).toBe('Plot 5')
        expect(body.pincode).toBe('641035')
        expect(body.gstin).toBe('33AABCC1234D1ZA')
        expect(body.links[0].link_doctype).toBe('Customer')
        expect(body.links[0].link_name).toBe('XYZ Ltd')
    })

    it('returns null silently on address creation failure', async () => {
        mockFetch.mockReturnValueOnce(ok([])).mockReturnValueOnce(serverError('Validation failed', 422))

        const result = await client.ensurePartyAddress('Supplier', 'Bad Supplier', {
            lines: ['Some address'],
        })

        expect(result).toBeNull()
    })
})

// ── ensurePartyContact ───────────────────────────────────────────────────────

describe('ensurePartyContact', () => {
    it('returns null when no contact data provided', async () => {
        const result = await client.ensurePartyContact('Customer', 'ABC Corp', {})
        expect(result).toBeNull()
        expect(mockFetch).not.toHaveBeenCalled()
    })

    it('returns existing contact name if already created', async () => {
        mockFetch.mockReturnValueOnce(ok([{ name: 'ABC Corp-Contact' }]))

        const result = await client.ensurePartyContact('Customer', 'ABC Corp', {
            email: 'abc@example.com',
        })

        expect(result).toBe('ABC Corp-Contact')
        expect(mockFetch).toHaveBeenCalledTimes(1)
    })

    it('creates a new contact with email', async () => {
        mockFetch.mockReturnValueOnce(ok([])).mockReturnValueOnce(ok({ name: 'XYZ Ltd-Contact' }))

        const result = await client.ensurePartyContact('Supplier', 'XYZ Ltd', {
            email: 'contact@xyz.com',
            mobile: '9999999999',
        })

        expect(result).toBe('XYZ Ltd-Contact')

        const body = JSON.parse(mockFetch.mock.calls[1][1].body)
        expect(body.first_name).toBe('XYZ Ltd')
        expect(body.email_ids[0].email_id).toBe('contact@xyz.com')
        expect(body.phone_nos[0].phone).toBe('9999999999')
    })

    it('creates contact with phone when no mobile', async () => {
        mockFetch.mockReturnValueOnce(ok([])).mockReturnValueOnce(ok({ name: 'Phone Contact' }))

        await client.ensurePartyContact('Customer', 'Phone Only', {
            phone: '044-12345678',
        })

        const body = JSON.parse(mockFetch.mock.calls[1][1].body)
        expect(body.phone_nos[0].is_primary_phone).toBe(1)
        expect(body.phone_nos[0].phone).toBe('044-12345678')
    })

    it('returns null silently on contact creation failure', async () => {
        mockFetch.mockReturnValueOnce(ok([])).mockReturnValueOnce(serverError('Error', 500))

        const result = await client.ensurePartyContact('Customer', 'Error Party', { email: 'x@y.com' })
        expect(result).toBeNull()
    })
})

// ── ensureCompanyAddress ─────────────────────────────────────────────────────

describe('ensureCompanyAddress', () => {
    it('returns existing address when already created', async () => {
        mockFetch.mockReturnValueOnce(ok([{ name: 'Covai Polymer Traders-Billing' }]))

        const name = await client.ensureCompanyAddress('Covai Polymer Traders', '33AABCZ2616B1ZV')

        expect(name).toBe('Covai Polymer Traders-Billing')
        expect(mockFetch).toHaveBeenCalledTimes(1)
    })

    it('creates company billing address with state derived from GSTIN code', async () => {
        mockFetch
            .mockReturnValueOnce(ok([])) // search
            .mockReturnValueOnce(ok({ name: 'My Company-Billing' })) // POST

        const name = await client.ensureCompanyAddress('My Company', '33AABCM1234Z1ZV')

        expect(name).toBe('My Company-Billing')

        const body = JSON.parse(mockFetch.mock.calls[1][1].body)
        expect(body.state).toBe('Tamil Nadu') // 33 = TN
        expect(body.city).toBe('Coimbatore')
        expect(body.gstin).toBe('33AABCM1234Z1ZV')
        expect(body.is_your_company_address).toBe(1)
        expect(body.links[0].link_doctype).toBe('Company')
    })

    it('derives Maharashtra address for GSTIN code 27', async () => {
        mockFetch.mockReturnValueOnce(ok([])).mockReturnValueOnce(ok({ name: 'MH Company-Billing' }))

        await client.ensureCompanyAddress('MH Company', '27AABCM9999Z1ZV')

        const body = JSON.parse(mockFetch.mock.calls[1][1].body)
        expect(body.state).toBe('Maharashtra')
        expect(body.city).toBe('Mumbai')
    })
})

// ── cancelAndAmend ───────────────────────────────────────────────────────────

describe('cancelAndAmend', () => {
    it('cancels, amends, updates and submits the amended doc', async () => {
        mockFetch
            .mockReturnValueOnce(ok(null)) // POST cancel
            .mockReturnValueOnce(ok({ name: 'SINV-001-1' })) // POST amend
            .mockReturnValueOnce(ok({ name: 'SINV-001-1' })) // PUT update
            .mockReturnValueOnce(ok(null)) // PUT submit

        const amendedName = await client.cancelAndAmend('Sales Invoice', 'SINV-001', { customer: 'New Customer' })

        expect(amendedName).toBe('SINV-001-1')

        // Call 0: cancel
        expect(mockFetch.mock.calls[0][0]).toContain('frappe.client.cancel')
        const cancelBody = JSON.parse(mockFetch.mock.calls[0][1].body)
        expect(cancelBody).toEqual({ doctype: 'Sales Invoice', name: 'SINV-001' })

        // Call 1: amend
        expect(mockFetch.mock.calls[1][0]).toContain('frappe.client.amend_doc')
        const amendBody = JSON.parse(mockFetch.mock.calls[1][1].body)
        expect(amendBody).toEqual({ doctype: 'Sales Invoice', name: 'SINV-001' })

        // Call 2: update
        expect(mockFetch.mock.calls[2][0]).toContain('/Sales%20Invoice/SINV-001-1')
        const updateBody = JSON.parse(mockFetch.mock.calls[2][1].body)
        expect(updateBody.customer).toBe('New Customer')
        expect(updateBody.custom_sync_source).toBe('TALLYBRIDGE')

        // Call 3: submit (docstatus=1)
        const submitBody = JSON.parse(mockFetch.mock.calls[3][1].body)
        expect(submitBody.docstatus).toBe(1)
    })

    it('throws if cancel fails', async () => {
        mockFetch.mockReturnValueOnce(serverError('Linked payment exists', 422))

        await expect(client.cancelAndAmend('Sales Invoice', 'SINV-001', {})).rejects.toBeInstanceOf(ERPNextError)
    })

    it('throws if amend fails', async () => {
        mockFetch
            .mockReturnValueOnce(ok(null)) // cancel OK
            .mockReturnValueOnce(serverError('Amend error')) // amend fails

        await expect(client.cancelAndAmend('Sales Invoice', 'SINV-001', {})).rejects.toBeInstanceOf(ERPNextError)
    })
})
