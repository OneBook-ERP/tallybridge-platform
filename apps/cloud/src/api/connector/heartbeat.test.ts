/**
 * Tests for POST /connector/heartbeat
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

const { mockSql, mockBroadcaster } = vi.hoisted(() => {
    const mockSql = Object.assign(vi.fn(() => Promise.resolve([])), { json: (v: unknown) => v })
    const mockBroadcaster = { emit: vi.fn() }
    return { mockSql, mockBroadcaster }
})

const CID = '00000000-0000-0000-0000-000000000001'
let mockIdentity = { companyId: CID, tallyCompanyName: 'Test Co' }

vi.mock('../../db/db', () => {
    const fn = (...args: unknown[]) => mockSql(...args)
    fn.json = (v: unknown) => v
    return { sql: fn }
})
vi.mock('../../auth/machine-tokens', () => ({
    requireConnectorAuth: vi.fn(async (request: Record<string, unknown>) => {
        request.connectorIdentity = mockIdentity
    }),
}))
vi.mock('../../realtime/broadcaster', () => ({ broadcaster: mockBroadcaster }))
vi.mock('../../lib/logger', () => ({
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { heartbeatRoute } from './heartbeat'

let app: FastifyInstance

beforeEach(async () => {
    vi.clearAllMocks()
    mockIdentity = { companyId: CID, tallyCompanyName: 'Test Co' }
    app = Fastify()
    await app.register(heartbeatRoute)
    await app.ready()
})

afterEach(() => app.close())

const validBody = {
    companyId: CID,
    tallyStatus: 'ONLINE',
    pendingLocalJobs: 0,
}

describe('POST /connector/heartbeat', () => {
    it('returns { ok: true } and updates company row', async () => {
        const res = await app.inject({
            method: 'POST',
            url: '/connector/heartbeat',
            payload: validBody,
            headers: { authorization: 'Bearer test-token' },
        })

        expect(res.statusCode).toBe(200)
        expect(JSON.parse(res.body)).toEqual({ ok: true })
        expect(mockSql).toHaveBeenCalled()
    })

    it('broadcasts connector:status event', async () => {
        await app.inject({
            method: 'POST',
            url: '/connector/heartbeat',
            payload: validBody,
            headers: { authorization: 'Bearer test-token' },
        })

        expect(mockBroadcaster.emit).toHaveBeenCalledWith(
            CID,
            'connector:status',
            expect.objectContaining({ companyId: CID, tallyStatus: 'ONLINE' }),
        )
    })

    it('returns 403 on token/companyId mismatch', async () => {
        mockIdentity = { companyId: '00000000-0000-0000-0000-000000000099', tallyCompanyName: 'Other' }

        const res = await app.inject({
            method: 'POST',
            url: '/connector/heartbeat',
            payload: validBody,
            headers: { authorization: 'Bearer test-token' },
        })

        expect(res.statusCode).toBe(403)
    })

    it('handles OFFLINE tallyStatus', async () => {
        const res = await app.inject({
            method: 'POST',
            url: '/connector/heartbeat',
            payload: { ...validBody, tallyStatus: 'OFFLINE' },
            headers: { authorization: 'Bearer test-token' },
        })

        expect(res.statusCode).toBe(200)
    })

    it('works with optional fields', async () => {
        const res = await app.inject({
            method: 'POST',
            url: '/connector/heartbeat',
            payload: { ...validBody, tallyVersion: '7.1', openCompany: 'Test Co' },
            headers: { authorization: 'Bearer test-token' },
        })

        expect(res.statusCode).toBe(200)
    })
})
