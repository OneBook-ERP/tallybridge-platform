/**
 * Tests for GET /connector/jobs/pending + wakeConnector
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

const { mockSql } = vi.hoisted(() => {
    const mockSql = Object.assign(vi.fn(() => Promise.resolve([])), { json: (v: unknown) => v })
    return { mockSql }
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

import { jobsRoute, wakeConnector } from './jobs'

let app: FastifyInstance

beforeEach(async () => {
    vi.clearAllMocks()
    mockIdentity = { companyId: CID, tallyCompanyName: 'Test Co' }
    app = Fastify()
    await app.register(jobsRoute)
    await app.ready()
})

afterEach(() => app.close())

describe('GET /connector/jobs/pending', () => {
    it('returns existing PENDING jobs immediately', async () => {
        mockSql.mockResolvedValueOnce([
            { id: 'job-1', job_type: 'CREATE', payload: { voucherType: 'Sales' } },
        ])

        const res = await app.inject({
            method: 'GET',
            url: `/connector/jobs/pending?companyId=${CID}&timeout=1`,
            headers: { authorization: 'Bearer t' },
        })

        expect(res.statusCode).toBe(200)
        const body = JSON.parse(res.body)
        expect(body.jobs).toHaveLength(1)
        expect(body.jobs[0].jobId).toBe('job-1')
        expect(body.jobs[0].action).toBe('CREATE')
    })

    it('long-poll timeout → empty array', async () => {
        mockSql.mockResolvedValueOnce([])

        const res = await app.inject({
            method: 'GET',
            url: `/connector/jobs/pending?companyId=${CID}&timeout=1`,
            headers: { authorization: 'Bearer t' },
        })

        expect(res.statusCode).toBe(200)
        expect(JSON.parse(res.body).jobs).toHaveLength(0)
    })

    it('wakeConnector resolves waiting connector', async () => {
        mockSql.mockResolvedValueOnce([])

        const resPromise = app.inject({
            method: 'GET',
            url: `/connector/jobs/pending?companyId=${CID}&timeout=5`,
            headers: { authorization: 'Bearer t' },
        })

        await new Promise((r) => setTimeout(r, 50))

        wakeConnector(CID, [
            { jobId: 'wake-1', action: 'CREATE', voucherType: 'Sales', payload: {} },
        ])

        const res = await resPromise
        expect(res.statusCode).toBe(200)
        const body = JSON.parse(res.body)
        expect(body.jobs).toHaveLength(1)
        expect(body.jobs[0].jobId).toBe('wake-1')
    })

    it('wakeConnector for unknown company is no-op', () => {
        expect(() => wakeConnector('unknown-co', [{ jobId: 'j', action: 'CREATE', voucherType: 'X', payload: {} }])).not.toThrow()
    })

    it('token mismatch → 403', async () => {
        mockIdentity = { companyId: '00000000-0000-0000-0000-000000000099', tallyCompanyName: 'X' }

        const res = await app.inject({
            method: 'GET',
            url: `/connector/jobs/pending?companyId=${CID}&timeout=1`,
            headers: { authorization: 'Bearer t' },
        })

        expect(res.statusCode).toBe(403)
    })

    it('timeout clamped: 0 → 1', async () => {
        mockSql.mockResolvedValueOnce([])

        const start = Date.now()
        const res = await app.inject({
            method: 'GET',
            url: `/connector/jobs/pending?companyId=${CID}&timeout=0`,
            headers: { authorization: 'Bearer t' },
        })

        const elapsed = Date.now() - start
        expect(res.statusCode).toBe(200)
        expect(elapsed).toBeGreaterThanOrEqual(900)
        expect(elapsed).toBeLessThan(3000)
    })

    it('timeout clamped: 100 → 30', async () => {
        mockSql.mockResolvedValueOnce([])

        const resPromise = app.inject({
            method: 'GET',
            url: `/connector/jobs/pending?companyId=${CID}&timeout=100`,
            headers: { authorization: 'Bearer t' },
        })

        await new Promise((r) => setTimeout(r, 50))
        wakeConnector(CID, [])

        const res = await resPromise
        expect(res.statusCode).toBe(200)
    })

    it('default timeout when not specified', async () => {
        mockSql.mockResolvedValueOnce([])

        const resPromise = app.inject({
            method: 'GET',
            url: `/connector/jobs/pending?companyId=${CID}`,
            headers: { authorization: 'Bearer t' },
        })

        await new Promise((r) => setTimeout(r, 50))
        wakeConnector(CID, [])

        const res = await resPromise
        expect(res.statusCode).toBe(200)
    })
})
