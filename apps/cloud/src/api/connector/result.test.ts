/**
 * Tests for POST /connector/sync-result and POST /connector/exception
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

const { mockSql, mockBroadcaster } = vi.hoisted(() => {
    const mockSql = Object.assign(
        vi.fn(() => Promise.resolve([])),
        { json: (v: unknown) => v },
    )
    const mockBroadcaster = { emit: vi.fn() }
    return { mockSql, mockBroadcaster }
})

const CID = '00000000-0000-0000-0000-000000000001'
const JOB_ID = '00000000-0000-0000-0000-000000000010'
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

import { resultRoute, exceptionRoute } from './result'

let app: FastifyInstance

beforeEach(async () => {
    vi.clearAllMocks()
    mockIdentity = { companyId: CID, tallyCompanyName: 'Test Co' }
    app = Fastify()
    await app.register(resultRoute)
    await app.register(exceptionRoute)
    await app.ready()
})

afterEach(() => app.close())

describe('POST /connector/sync-result', () => {
    const base = { jobId: JOB_ID, companyId: CID }

    it('SUCCESS updates job_log', async () => {
        const res = await app.inject({
            method: 'POST',
            url: '/connector/sync-result',
            payload: { ...base, status: 'SUCCESS' },
            headers: { authorization: 'Bearer t' },
        })

        expect(res.statusCode).toBe(200)
        expect(mockSql).toHaveBeenCalled()
    })

    it('SUCCESS + tallyGuid updates sync_records', async () => {
        await app.inject({
            method: 'POST',
            url: '/connector/sync-result',
            payload: { ...base, status: 'SUCCESS', tallyGuid: 'guid-001' },
            headers: { authorization: 'Bearer t' },
        })

        // Should have at least 2 sql calls: job_log UPDATE + sync_records UPDATE
        expect(mockSql.mock.calls.length).toBeGreaterThanOrEqual(2)
        const queries = mockSql.mock.calls.map((c) => c[0].join('?'))
        expect(queries.some((q: string) => q.includes('sync_records'))).toBe(true)
    })

    it('SUCCESS without tallyGuid skips sync_records', async () => {
        await app.inject({
            method: 'POST',
            url: '/connector/sync-result',
            payload: { ...base, status: 'SUCCESS' },
            headers: { authorization: 'Bearer t' },
        })

        // Only 1 sql call: job_log UPDATE
        const queries = mockSql.mock.calls.map((c) => c[0].join('?'))
        expect(queries.filter((q: string) => q.includes('sync_records'))).toHaveLength(0)
    })

    it('ERROR stores errorMessage', async () => {
        await app.inject({
            method: 'POST',
            url: '/connector/sync-result',
            payload: { ...base, status: 'ERROR', errorMessage: 'Tally rejected' },
            headers: { authorization: 'Bearer t' },
        })

        expect(mockSql).toHaveBeenCalled()
    })

    it('broadcasts job:completed', async () => {
        await app.inject({
            method: 'POST',
            url: '/connector/sync-result',
            payload: { ...base, status: 'SUCCESS' },
            headers: { authorization: 'Bearer t' },
        })

        expect(mockBroadcaster.emit).toHaveBeenCalledWith(
            CID,
            'job:completed',
            expect.objectContaining({ jobId: JOB_ID, status: 'SUCCESS' }),
        )
    })

    it('returns 403 on token mismatch', async () => {
        mockIdentity = { companyId: '00000000-0000-0000-0000-000000000099', tallyCompanyName: 'X' }

        const res = await app.inject({
            method: 'POST',
            url: '/connector/sync-result',
            payload: { ...base, status: 'SUCCESS' },
            headers: { authorization: 'Bearer t' },
        })

        expect(res.statusCode).toBe(403)
    })
})

describe('POST /connector/exception', () => {
    const base = { companyId: CID, errorCode: 'UNMAPPED_LEDGER', message: 'Unknown ledger' }

    it('TIER1_AUTO inserts into exception_register', async () => {
        const res = await app.inject({
            method: 'POST',
            url: '/connector/exception',
            payload: { ...base, tier: 'TIER1_AUTO' },
            headers: { authorization: 'Bearer t' },
        })

        expect(res.statusCode).toBe(201)
        const queries = mockSql.mock.calls.map((c) => c[0].join('?'))
        expect(queries.some((q: string) => q.includes('exception_register'))).toBe(true)
    })

    it('TIER2_FLAG inserts correctly', async () => {
        const res = await app.inject({
            method: 'POST',
            url: '/connector/exception',
            payload: { ...base, tier: 'TIER2_FLAG' },
            headers: { authorization: 'Bearer t' },
        })

        expect(res.statusCode).toBe(201)
    })

    it('TIER3_BLOCK inserts correctly', async () => {
        const res = await app.inject({
            method: 'POST',
            url: '/connector/exception',
            payload: { ...base, tier: 'TIER3_BLOCK' },
            headers: { authorization: 'Bearer t' },
        })

        expect(res.statusCode).toBe(201)
    })

    it('broadcasts exception:new event', async () => {
        await app.inject({
            method: 'POST',
            url: '/connector/exception',
            payload: { ...base, tier: 'TIER2_FLAG' },
            headers: { authorization: 'Bearer t' },
        })

        expect(mockBroadcaster.emit).toHaveBeenCalledWith(
            CID,
            'exception:new',
            expect.objectContaining({ tier: 'TIER2_FLAG', message: 'Unknown ledger' }),
        )
    })
})
