/**
 * Tests for POST /connector/sync-data
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

const { mockEnqueueSyncBatch } = vi.hoisted(() => ({
    mockEnqueueSyncBatch: vi.fn(() => Promise.resolve('job-001')),
}))

const CID = '00000000-0000-0000-0000-000000000001'
let mockIdentity = { companyId: CID, tallyCompanyName: 'Test Co' }

vi.mock('../../auth/machine-tokens', () => ({
    requireConnectorAuth: vi.fn(async (request: Record<string, unknown>) => {
        request.connectorIdentity = mockIdentity
    }),
}))
vi.mock('../../queue/producer', () => ({
    enqueueSyncBatch: (...args: unknown[]) => mockEnqueueSyncBatch(...args),
}))
vi.mock('../../lib/logger', () => ({
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { syncDataRoute } from './sync-data'

let app: FastifyInstance

beforeEach(async () => {
    vi.clearAllMocks()
    mockIdentity = { companyId: CID, tallyCompanyName: 'Test Co' }
    app = Fastify()
    await app.register(syncDataRoute)
    await app.ready()
})

afterEach(() => app.close())

const base = { companyId: CID, fromTimestamp: '20240401000000', toTimestamp: '20240430235959' }

describe('POST /connector/sync-data', () => {
    it('empty payload returns queued: 0', async () => {
        const res = await app.inject({
            method: 'POST',
            url: '/connector/sync-data',
            payload: base,
            headers: { authorization: 'Bearer t' },
        })

        expect(res.statusCode).toBe(200)
        expect(JSON.parse(res.body).queued).toBe(0)
        expect(mockEnqueueSyncBatch).not.toHaveBeenCalled()
    })

    it('vouchers → recordType: voucher', async () => {
        const res = await app.inject({
            method: 'POST',
            url: '/connector/sync-data',
            payload: { ...base, vouchers: [{ guid: 'v1' }] },
            headers: { authorization: 'Bearer t' },
        })

        expect(res.statusCode).toBe(200)
        expect(mockEnqueueSyncBatch).toHaveBeenCalledWith(
            expect.objectContaining({ recordType: 'voucher' }),
        )
    })

    it('ledgers → recordType: ledger (priority)', async () => {
        await app.inject({
            method: 'POST',
            url: '/connector/sync-data',
            payload: { ...base, ledgers: [{ name: 'L1' }], vouchers: [{ guid: 'v1' }] },
            headers: { authorization: 'Bearer t' },
        })

        expect(mockEnqueueSyncBatch).toHaveBeenCalledWith(
            expect.objectContaining({ recordType: 'ledger' }),
        )
    })

    it('stockItems → recordType: stockItem', async () => {
        await app.inject({
            method: 'POST',
            url: '/connector/sync-data',
            payload: { ...base, stockItems: [{ name: 'S1' }] },
            headers: { authorization: 'Bearer t' },
        })

        expect(mockEnqueueSyncBatch).toHaveBeenCalledWith(
            expect.objectContaining({ recordType: 'stockItem' }),
        )
    })

    it('returns valid UUID as batchId', async () => {
        const res = await app.inject({
            method: 'POST',
            url: '/connector/sync-data',
            payload: { ...base, vouchers: [{ guid: 'v1' }] },
            headers: { authorization: 'Bearer t' },
        })

        const body = JSON.parse(res.body)
        expect(body.batchId).toMatch(/^[0-9a-f-]{36}$/)
    })

    it('returns 403 on token/companyId mismatch', async () => {
        mockIdentity = { companyId: '00000000-0000-0000-0000-000000000099', tallyCompanyName: 'X' }

        const res = await app.inject({
            method: 'POST',
            url: '/connector/sync-data',
            payload: { ...base, vouchers: [{ guid: 'v1' }] },
            headers: { authorization: 'Bearer t' },
        })

        expect(res.statusCode).toBe(403)
    })
})
