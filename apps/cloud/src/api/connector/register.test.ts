/**
 * Tests for POST /connector/register
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'

const { mockSql, mockIssueMachineToken } = vi.hoisted(() => {
    const mockSql = Object.assign(
        vi.fn(() => Promise.resolve([{ id: 'comp-uuid-001' }])),
        { json: (val: unknown) => val },
    )
    const mockIssueMachineToken = vi.fn(() => Promise.resolve('mock-token-abc'))
    return { mockSql, mockIssueMachineToken }
})

vi.mock('../../db/db', () => {
    const fn = (...args: unknown[]) => mockSql(...args)
    fn.json = (val: unknown) => val
    return { sql: fn }
})
vi.mock('../../auth/machine-tokens', () => ({
    issueMachineToken: (...args: unknown[]) => mockIssueMachineToken(...args),
    requireConnectorAuth: vi.fn(),
    verifyMachineToken: vi.fn(),
}))
vi.mock('../../lib/logger', () => ({
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { registerRoute } from './register'

let app: FastifyInstance

beforeEach(async () => {
    vi.clearAllMocks()
    mockSql.mockResolvedValue([{ id: 'comp-uuid-001' }])
    mockIssueMachineToken.mockResolvedValue('mock-token-abc')
    app = Fastify()
    await app.register(registerRoute)
    await app.ready()
})

afterEach(() => app.close())

describe('POST /connector/register', () => {
    const validBody = { machineId: 'machine-001', companyName: 'Test Company' }

    it('returns machineToken + companyId + cloudConfig', async () => {
        const res = await app.inject({ method: 'POST', url: '/connector/register', payload: validBody })
        const body = JSON.parse(res.body)

        expect(res.statusCode).toBe(200)
        expect(body.machineToken).toBe('mock-token-abc')
        expect(body.companyId).toBe('comp-uuid-001')
        expect(body.cloudConfig).toBeDefined()
        expect(body.cloudConfig.pollIntervalMinutes).toBe(5)
    })

    it('calls issueMachineToken with correct companyId', async () => {
        await app.inject({ method: 'POST', url: '/connector/register', payload: validBody })

        expect(mockIssueMachineToken).toHaveBeenCalledWith('comp-uuid-001')
    })

    it('passes companyName and machineId to upsert query', async () => {
        await app.inject({ method: 'POST', url: '/connector/register', payload: validBody })

        expect(mockSql).toHaveBeenCalled()
        // First sql call is the companies INSERT
        const firstCallValues = mockSql.mock.calls[0].slice(1).flat()
        expect(firstCallValues).toContain('Test Company')
        expect(firstCallValues).toContain('machine-001')
    })

    it('seeds config_profiles with mappingConfigs', async () => {
        const payload = {
            ...validBody,
            mappingConfigs: {
                account_coa: { 'B2B Sales': 'Sales - TC' },
                gst_ledger: { output_cgst: 'Output CGST - TC' },
            },
        }
        await app.inject({ method: 'POST', url: '/connector/register', payload })

        // Second sql call is config_profiles INSERT
        expect(mockSql.mock.calls.length).toBeGreaterThanOrEqual(2)
    })

    it('works with missing optional fields', async () => {
        const res = await app.inject({
            method: 'POST',
            url: '/connector/register',
            payload: { machineId: 'machine-002', companyName: 'Minimal Co' },
        })

        expect(res.statusCode).toBe(200)
    })

    it('returns 400 for missing machineId', async () => {
        const res = await app.inject({
            method: 'POST',
            url: '/connector/register',
            payload: { companyName: 'Test' },
        })

        expect(res.statusCode).toBe(400)
    })

    it('returns 400 for missing companyName', async () => {
        const res = await app.inject({
            method: 'POST',
            url: '/connector/register',
            payload: { machineId: 'machine-001' },
        })

        expect(res.statusCode).toBe(400)
    })
})
