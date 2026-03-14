import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ERPNextClient, ERPNextError } from './client'

// Mock global fetch
const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

function jsonResponse(data: unknown, status = 200) {
    return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => ({ data }),
    }
}

function errorResponse(status: number, message: string, serverMessages?: string) {
    return {
        ok: false,
        status,
        json: async () => ({
            message,
            _server_messages: serverMessages,
        }),
    }
}

describe('ERPNextClient', () => {
    let client: ERPNextClient

    beforeEach(() => {
        vi.clearAllMocks()
        client = new ERPNextClient({
            baseUrl: 'https://erp.example.com',
            apiKey: 'testkey',
            apiSecret: 'testsecret',
        })
    })

    describe('getDoc', () => {
        it('fetches a document by doctype and name', async () => {
            mockFetch.mockResolvedValueOnce(jsonResponse({ name: 'SINV-001', customer: 'Test' }))
            const doc = await client.getDoc('Sales Invoice', 'SINV-001')
            expect(doc).toEqual({ name: 'SINV-001', customer: 'Test' })
            expect(mockFetch).toHaveBeenCalledWith(
                'https://erp.example.com/api/resource/Sales%20Invoice/SINV-001',
                expect.objectContaining({ method: 'GET' }),
            )
        })

        it('includes authorization header', async () => {
            mockFetch.mockResolvedValueOnce(jsonResponse({}))
            await client.getDoc('Customer', 'Test')
            const callArgs = mockFetch.mock.calls[0][1]
            expect(callArgs.headers.Authorization).toBe('token testkey:testsecret')
        })
    })

    describe('findByTallyGUID', () => {
        it('returns name when document exists', async () => {
            mockFetch.mockResolvedValueOnce(jsonResponse([{ name: 'SINV-001' }]))
            const name = await client.findByTallyGUID('Sales Invoice', 'guid-123')
            expect(name).toBe('SINV-001')
        })

        it('returns null when no match', async () => {
            mockFetch.mockResolvedValueOnce(jsonResponse([]))
            const name = await client.findByTallyGUID('Sales Invoice', 'guid-missing')
            expect(name).toBeNull()
        })
    })

    describe('createDoc', () => {
        it('sends POST with custom_sync_source', async () => {
            mockFetch.mockResolvedValueOnce(jsonResponse({ name: 'SINV-002' }))
            const result = await client.createDoc<{ name: string }>('Sales Invoice', {
                customer: 'Test',
                posting_date: '2024-04-01',
            })
            expect(result.name).toBe('SINV-002')
            const callArgs = mockFetch.mock.calls[0]
            const body = JSON.parse(callArgs[1].body)
            expect(body.custom_sync_source).toBe('TALLYBRIDGE')
        })
    })

    describe('error handling', () => {
        it('throws ERPNextError on non-ok response', async () => {
            mockFetch.mockResolvedValueOnce(errorResponse(404, 'Not Found'))
            await expect(client.getDoc('Customer', 'Missing')).rejects.toThrow(ERPNextError)
        })

        it('parses _server_messages JSON-in-JSON', async () => {
            const serverMsgs = JSON.stringify([JSON.stringify({ message: 'Duplicate entry' })])
            mockFetch.mockResolvedValueOnce(errorResponse(409, 'Conflict', serverMsgs))
            try {
                await client.getDoc('Customer', 'Dup')
                expect.unreachable('should have thrown')
            } catch (err) {
                expect(err).toBeInstanceOf(ERPNextError)
                expect((err as ERPNextError).message).toContain('Duplicate entry')
            }
        })

        it('retries on 429 rate limit', async () => {
            // First call returns 429, second succeeds
            mockFetch
                .mockResolvedValueOnce({
                    ok: false,
                    status: 429,
                    json: async () => ({ message: 'Rate limited' }),
                })
                .mockResolvedValueOnce(jsonResponse({ name: 'OK' }))

            const result = await client.getDoc<{ name: string }>('Item', 'Widget')
            expect(result.name).toBe('OK')
            expect(mockFetch).toHaveBeenCalledTimes(2)
        })
    })

    describe('ensureCustomer', () => {
        it('creates customer when 404', async () => {
            // getDoc throws 404
            mockFetch.mockResolvedValueOnce(errorResponse(404, 'Not Found'))
            // createDoc succeeds
            mockFetch.mockResolvedValueOnce(jsonResponse({ name: 'New Customer' }))

            await client.ensureCustomer('New Customer', '33AABCN1234D1ZA')

            // Second call should be POST to create
            expect(mockFetch).toHaveBeenCalledTimes(2)
            const createBody = JSON.parse(mockFetch.mock.calls[1][1].body)
            expect(createBody.customer_name).toBe('New Customer')
            expect(createBody.gstin).toBe('33AABCN1234D1ZA')
            expect(createBody.gst_category).toBe('Registered Regular')
        })

        it('updates GSTIN on existing customer without one', async () => {
            // getDoc returns customer without GSTIN
            mockFetch.mockResolvedValueOnce(jsonResponse({ name: 'Existing', gstin: '' }))
            // updateDoc
            mockFetch.mockResolvedValueOnce(jsonResponse({ name: 'Existing' }))

            await client.ensureCustomer('Existing', '33AABCE5678E1ZB')

            expect(mockFetch).toHaveBeenCalledTimes(2)
            const updateBody = JSON.parse(mockFetch.mock.calls[1][1].body)
            expect(updateBody.gstin).toBe('33AABCE5678E1ZB')
        })

        it('does nothing if customer exists with GSTIN', async () => {
            mockFetch.mockResolvedValueOnce(jsonResponse({ name: 'Existing', gstin: '33AABCE5678E1ZB' }))
            await client.ensureCustomer('Existing', '33AABCE5678E1ZB')
            expect(mockFetch).toHaveBeenCalledTimes(1) // only the getDoc call
        })
    })

    describe('ensureItem', () => {
        it('creates item with fallback HSN when 404', async () => {
            mockFetch.mockResolvedValueOnce(errorResponse(404, 'Not Found'))
            mockFetch.mockResolvedValueOnce(jsonResponse({ name: 'New Item' }))

            await client.ensureItem('New Item')

            const createBody = JSON.parse(mockFetch.mock.calls[1][1].body)
            expect(createBody.item_code).toBe('New Item')
            expect(createBody.gst_hsn_code).toBe('999111') // fallback SAC
            expect(createBody.stock_uom).toBe('Nos')
        })

        it('uses provided HSN and UOM', async () => {
            mockFetch.mockResolvedValueOnce(errorResponse(404, 'Not Found'))
            mockFetch.mockResolvedValueOnce(jsonResponse({ name: 'Widget' }))

            await client.ensureItem('Widget', 'Pcs', '84719000')

            const createBody = JSON.parse(mockFetch.mock.calls[1][1].body)
            expect(createBody.stock_uom).toBe('Pcs')
            expect(createBody.gst_hsn_code).toBe('84719000')
        })

        it('updates HSN when existing item has fallback SAC and Tally provides real HSN', async () => {
            // getDoc returns item with fallback HSN
            mockFetch.mockResolvedValueOnce(jsonResponse({ name: 'Old Item', gst_hsn_code: '999111', item_group: 'All Item Groups' }))
            // updateDoc
            mockFetch.mockResolvedValueOnce(jsonResponse({ name: 'Old Item' }))

            await client.ensureItem('Old Item', 'Nos', '84719000')

            expect(mockFetch).toHaveBeenCalledTimes(2)
            const updateBody = JSON.parse(mockFetch.mock.calls[1][1].body)
            expect(updateBody.gst_hsn_code).toBe('84719000')
        })

        it('does not update HSN when existing item already has real HSN', async () => {
            mockFetch.mockResolvedValueOnce(jsonResponse({ name: 'Item', gst_hsn_code: '39201090', item_group: 'Polymers' }))

            await client.ensureItem('Item', 'Nos', '84719000')

            expect(mockFetch).toHaveBeenCalledTimes(1) // only getDoc
        })

        it('creates item with custom group when provided', async () => {
            mockFetch.mockResolvedValueOnce(errorResponse(404, 'Not Found'))
            mockFetch.mockResolvedValueOnce(jsonResponse({ name: 'Widget' }))

            await client.ensureItem('Widget', 'Nos', '84719000', 'Raw Materials')

            const createBody = JSON.parse(mockFetch.mock.calls[1][1].body)
            expect(createBody.item_group).toBe('Raw Materials')
        })

        it('updates item group when existing is default', async () => {
            mockFetch.mockResolvedValueOnce(jsonResponse({ name: 'Item', gst_hsn_code: '84719000', item_group: 'All Item Groups' }))
            mockFetch.mockResolvedValueOnce(jsonResponse({ name: 'Item' }))

            await client.ensureItem('Item', 'Nos', undefined, 'Finished Goods')

            expect(mockFetch).toHaveBeenCalledTimes(2)
            const updateBody = JSON.parse(mockFetch.mock.calls[1][1].body)
            expect(updateBody.item_group).toBe('Finished Goods')
        })
    })

    describe('ensureCustomer — groups', () => {
        it('creates customer with custom group', async () => {
            mockFetch.mockResolvedValueOnce(errorResponse(404, 'Not Found'))
            mockFetch.mockResolvedValueOnce(jsonResponse({ name: 'New Cust' }))

            await client.ensureCustomer('New Cust', undefined, 'Wholesale')

            const createBody = JSON.parse(mockFetch.mock.calls[1][1].body)
            expect(createBody.customer_group).toBe('Wholesale')
        })

        it('updates group when existing has default group', async () => {
            mockFetch.mockResolvedValueOnce(jsonResponse({ name: 'Cust', gstin: '33AAB', customer_group: 'All Customer Groups' }))
            mockFetch.mockResolvedValueOnce(jsonResponse({ name: 'Cust' }))

            await client.ensureCustomer('Cust', undefined, 'Retail')

            expect(mockFetch).toHaveBeenCalledTimes(2)
            const updateBody = JSON.parse(mockFetch.mock.calls[1][1].body)
            expect(updateBody.customer_group).toBe('Retail')
        })
    })

    describe('ensureSupplier — groups', () => {
        it('creates supplier with custom group', async () => {
            mockFetch.mockResolvedValueOnce(errorResponse(404, 'Not Found'))
            mockFetch.mockResolvedValueOnce(jsonResponse({ name: 'New Supp' }))

            await client.ensureSupplier('New Supp', undefined, 'Local')

            const createBody = JSON.parse(mockFetch.mock.calls[1][1].body)
            expect(createBody.supplier_group).toBe('Local')
        })
    })

    describe('ensureCompanyAddress', () => {
        it('returns existing address if found', async () => {
            mockFetch.mockResolvedValueOnce(jsonResponse([{ name: 'Test Co-Billing' }]))

            const name = await client.ensureCompanyAddress('Test Co', '33AABCT1234A1ZA')

            expect(name).toBe('Test Co-Billing')
            expect(mockFetch).toHaveBeenCalledTimes(1)
        })

        it('creates address when none exists', async () => {
            // Search returns empty
            mockFetch.mockResolvedValueOnce(jsonResponse([]))
            // Create returns new address
            mockFetch.mockResolvedValueOnce(jsonResponse({ name: 'Test Co-Billing' }))

            const name = await client.ensureCompanyAddress('Test Co', '33AABCT1234A1ZA')

            expect(name).toBe('Test Co-Billing')
            expect(mockFetch).toHaveBeenCalledTimes(2)
            const createBody = JSON.parse(mockFetch.mock.calls[1][1].body)
            expect(createBody.gstin).toBe('33AABCT1234A1ZA')
            expect(createBody.state).toBe('Tamil Nadu')
            expect(createBody.is_your_company_address).toBe(1)
        })
    })

    describe('ensurePartyAddress', () => {
        it('skips when no address data provided', async () => {
            const result = await client.ensurePartyAddress('Customer', 'Test Corp', {})
            expect(result).toBeNull()
            expect(mockFetch).not.toHaveBeenCalled()
        })

        it('returns existing address if one exists', async () => {
            mockFetch.mockResolvedValueOnce(jsonResponse([{ name: 'Test Corp-Billing' }]))

            const result = await client.ensurePartyAddress('Customer', 'Test Corp', {
                lines: ['123 Main St', 'Coimbatore - 641035'],
                pinCode: '641035',
                state: 'Tamil Nadu',
            })

            expect(result).toBe('Test Corp-Billing')
            expect(mockFetch).toHaveBeenCalledTimes(1)
        })

        it('creates address with Tally data when none exists', async () => {
            // Search returns empty
            mockFetch.mockResolvedValueOnce(jsonResponse([]))
            // Create succeeds
            mockFetch.mockResolvedValueOnce(jsonResponse({ name: 'Test Corp-Billing' }))

            const result = await client.ensurePartyAddress('Supplier', 'Test Corp', {
                lines: ['NO: 2, LAKSHMI GARDEN', 'KEERANATHAM', 'COIMBATORE - 641035'],
                pinCode: '641035',
                state: 'Tamil Nadu',
                country: 'India',
                gstin: '33AABCT1234A1ZA',
            })

            expect(result).toBe('Test Corp-Billing')
            expect(mockFetch).toHaveBeenCalledTimes(2)
            const createBody = JSON.parse(mockFetch.mock.calls[1][1].body)
            expect(createBody.address_line1).toBe('NO: 2, LAKSHMI GARDEN')
            expect(createBody.address_line2).toBe('KEERANATHAM, COIMBATORE - 641035')
            expect(createBody.pincode).toBe('641035')
            expect(createBody.state).toBe('Tamil Nadu')
            expect(createBody.gstin).toBe('33AABCT1234A1ZA')
            expect(createBody.links[0].link_doctype).toBe('Supplier')
            expect(createBody.links[0].link_name).toBe('Test Corp')
        })

        it('extracts city from last address line', async () => {
            mockFetch.mockResolvedValueOnce(jsonResponse([]))
            mockFetch.mockResolvedValueOnce(jsonResponse({ name: 'Addr' }))

            await client.ensurePartyAddress('Customer', 'Cust', {
                lines: ['Street 1', 'CHENNAI - 600103'],
                pinCode: '600103',
            })

            const createBody = JSON.parse(mockFetch.mock.calls[1][1].body)
            expect(createBody.city).toBe('CHENNAI')
        })
    })

    describe('ensurePartyContact', () => {
        it('skips when no contact data provided', async () => {
            const result = await client.ensurePartyContact('Customer', 'Test Corp', {})
            expect(result).toBeNull()
            expect(mockFetch).not.toHaveBeenCalled()
        })

        it('returns existing contact if one exists', async () => {
            mockFetch.mockResolvedValueOnce(jsonResponse([{ name: 'Test Corp-Contact' }]))

            const result = await client.ensurePartyContact('Customer', 'Test Corp', {
                email: 'test@example.com',
            })

            expect(result).toBe('Test Corp-Contact')
            expect(mockFetch).toHaveBeenCalledTimes(1)
        })

        it('creates contact with email and mobile', async () => {
            mockFetch.mockResolvedValueOnce(jsonResponse([]))
            mockFetch.mockResolvedValueOnce(jsonResponse({ name: 'New Contact' }))

            const result = await client.ensurePartyContact('Customer', 'ABI POLY', {
                email: 'abi@example.com',
                mobile: '9894133129',
            })

            expect(result).toBe('New Contact')
            const createBody = JSON.parse(mockFetch.mock.calls[1][1].body)
            expect(createBody.first_name).toBe('ABI POLY')
            expect(createBody.email_ids[0].email_id).toBe('abi@example.com')
            expect(createBody.phone_nos[0].phone).toBe('9894133129')
            expect(createBody.links[0].link_doctype).toBe('Customer')
        })

        it('creates contact with phone only (no mobile)', async () => {
            mockFetch.mockResolvedValueOnce(jsonResponse([]))
            mockFetch.mockResolvedValueOnce(jsonResponse({ name: 'Phone Contact' }))

            await client.ensurePartyContact('Supplier', 'Supp', { phone: '04224567890' })

            const createBody = JSON.parse(mockFetch.mock.calls[1][1].body)
            expect(createBody.phone_nos[0].phone).toBe('04224567890')
            expect(createBody.phone_nos[0].is_primary_phone).toBe(1)
        })
    })

    describe('submitDoc', () => {
        it('sends PUT with docstatus 1', async () => {
            mockFetch.mockResolvedValueOnce(jsonResponse({}))
            await client.submitDoc('Sales Invoice', 'SINV-001')
            const callArgs = mockFetch.mock.calls[0]
            expect(callArgs[1].method).toBe('PUT')
            const body = JSON.parse(callArgs[1].body)
            expect(body.docstatus).toBe(1)
        })
    })
})
