/**
 * Unit tests for sync loop guard (Redis-based).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockRedis } = vi.hoisted(() => {
    const mockRedis = {
        set: vi.fn(() => Promise.resolve('OK')),
        get: vi.fn(() => Promise.resolve(null)),
        del: vi.fn(() => Promise.resolve(1)),
    }
    return { mockRedis }
})

vi.mock('../queue/queues', () => ({ redis: mockRedis }))
vi.mock('../lib/logger', () => ({
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { markWritten, isOwnWrite, clearWritten } from './loop-guard'

beforeEach(() => {
    vi.clearAllMocks()
})

describe('loop-guard', () => {
    const companyId = 'comp-001'
    const guid = 'voucher-guid-abc'
    const expectedKey = `tb:guard:${companyId}:${guid}`

    it('markWritten calls redis.set with correct key and TTL 120', async () => {
        await markWritten(companyId, guid)

        expect(mockRedis.set).toHaveBeenCalledWith(expectedKey, '1', 'EX', 120)
    })

    it('isOwnWrite returns true when redis.get returns "1"', async () => {
        mockRedis.get.mockResolvedValue('1')

        const result = await isOwnWrite(companyId, guid)

        expect(result).toBe(true)
        expect(mockRedis.get).toHaveBeenCalledWith(expectedKey)
    })

    it('isOwnWrite returns false when redis.get returns null', async () => {
        mockRedis.get.mockResolvedValue(null)

        const result = await isOwnWrite(companyId, guid)

        expect(result).toBe(false)
    })

    it('clearWritten calls redis.del with correct key', async () => {
        await clearWritten(companyId, guid)

        expect(mockRedis.del).toHaveBeenCalledWith(expectedKey)
    })

    it('key format is tb:guard:{companyId}:{guid}', async () => {
        await markWritten('my-company', 'my-guid')

        expect(mockRedis.set).toHaveBeenCalledWith(
            'tb:guard:my-company:my-guid',
            '1',
            'EX',
            120,
        )
    })

    it('markWritten then isOwnWrite returns true', async () => {
        // Simulate redis storing the value
        mockRedis.set.mockImplementation(() => {
            mockRedis.get.mockResolvedValue('1')
            return Promise.resolve('OK')
        })

        await markWritten(companyId, guid)
        const result = await isOwnWrite(companyId, guid)

        expect(result).toBe(true)
    })
})
