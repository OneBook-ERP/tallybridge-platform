/**
 * Unit tests for conflict detection module.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { makeVoucher } from '../test/fixtures'

const { mockSql, mockBroadcaster } = vi.hoisted(() => {
    const mockSql = Object.assign(
        vi.fn(() => Promise.resolve([])),
        { json: (val: unknown) => val },
    )
    const mockBroadcaster = { emit: vi.fn() }
    return { mockSql, mockBroadcaster }
})

vi.mock('../db/db', () => {
    const fn = (...args: unknown[]) => mockSql(...args)
    fn.json = (val: unknown) => val
    return { sql: fn, jsonb: (val: unknown) => val }
})
vi.mock('../realtime/broadcaster', () => ({ broadcaster: mockBroadcaster }))
vi.mock('../lib/logger', () => ({
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { checkConflict, recordConflict } from './conflict'

beforeEach(() => {
    vi.clearAllMocks()
    mockSql.mockResolvedValue([])
})

describe('checkConflict', () => {
    const companyId = 'comp-001'
    const voucher = makeVoucher({ guid: 'guid-001' })

    it('returns { hasConflict: false } when no existing sync_record', async () => {
        mockSql.mockResolvedValue([])

        const result = await checkConflict(companyId, voucher, 'hash-new')

        expect(result.hasConflict).toBe(false)
        expect(result.syncRecordId).toBeUndefined()
    })

    it('returns { hasConflict: false, syncRecordId } when hash unchanged', async () => {
        mockSql.mockResolvedValue([
            {
                id: 'rec-1',
                tally_hash: 'hash-same',
                erpnext_hash: '',
                erpnext_name: 'SINV-001',
                erpnext_doctype: 'Sales Invoice',
                sync_status: 'SYNCED',
            },
        ])

        const result = await checkConflict(companyId, voucher, 'hash-same')

        expect(result.hasConflict).toBe(false)
        expect(result.syncRecordId).toBe('rec-1')
        // No erpnextName when hash unchanged (skip path)
        expect(result.erpnextName).toBeUndefined()
    })

    it('returns erpnextName when only tally hash changed (update path)', async () => {
        mockSql.mockResolvedValue([
            {
                id: 'rec-1',
                tally_hash: 'hash-old',
                erpnext_hash: '',
                erpnext_name: 'SINV-001',
                erpnext_doctype: 'Sales Invoice',
                sync_status: 'SYNCED',
            },
        ])

        const result = await checkConflict(companyId, voucher, 'hash-new')

        expect(result.hasConflict).toBe(false)
        expect(result.erpnextName).toBe('SINV-001')
        expect(result.erpnextDoctype).toBe('Sales Invoice')
    })

    it('returns hasConflict: true when both hashes changed', async () => {
        mockSql.mockResolvedValue([
            {
                id: 'rec-1',
                tally_hash: 'hash-old',
                erpnext_hash: 'erp-hash-different',
                erpnext_name: 'SINV-001',
                erpnext_doctype: 'Sales Invoice',
                sync_status: 'SYNCED',
            },
        ])

        const result = await checkConflict(companyId, voucher, 'hash-new')

        expect(result.hasConflict).toBe(true)
        expect(result.erpnextName).toBe('SINV-001')
        expect(result.erpnextDoctype).toBe('Sales Invoice')
    })

    it('treats empty erpnext_hash as no ERPNext change', async () => {
        mockSql.mockResolvedValue([
            {
                id: 'rec-1',
                tally_hash: 'hash-old',
                erpnext_hash: '',
                erpnext_name: 'SINV-001',
                erpnext_doctype: 'Sales Invoice',
                sync_status: 'SYNCED',
            },
        ])

        const result = await checkConflict(companyId, voucher, 'hash-new')

        expect(result.hasConflict).toBe(false)
    })

    it('treats erpnext_hash === tally_hash as no ERPNext change', async () => {
        mockSql.mockResolvedValue([
            {
                id: 'rec-1',
                tally_hash: 'hash-old',
                erpnext_hash: 'hash-old', // same as stored tally_hash
                erpnext_name: 'SINV-001',
                erpnext_doctype: 'Sales Invoice',
                sync_status: 'SYNCED',
            },
        ])

        const result = await checkConflict(companyId, voucher, 'hash-new')

        expect(result.hasConflict).toBe(false)
    })
})

describe('recordConflict', () => {
    it('inserts into conflict_log', async () => {
        await recordConflict('comp-001', 'guid-001', { tally: 'data' }, { erp: 'data' })

        expect(mockSql).toHaveBeenCalled()
        const query = mockSql.mock.calls[0][0].join('?')
        expect(query).toContain('conflict_log')
    })

    it('broadcasts conflict:detected event', async () => {
        await recordConflict('comp-001', 'guid-001', {}, {})

        expect(mockBroadcaster.emit).toHaveBeenCalledWith(
            'comp-001',
            'conflict:detected',
            expect.objectContaining({
                companyId: 'comp-001',
                guid: 'guid-001',
            }),
        )
    })

    it('uses ON CONFLICT DO NOTHING to prevent duplicates', async () => {
        await recordConflict('comp-001', 'guid-001', {}, {})

        const query = mockSql.mock.calls[0][0].join('?')
        expect(query).toContain('ON CONFLICT DO NOTHING')
    })
})
