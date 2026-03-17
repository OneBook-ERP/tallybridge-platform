/**
 * Group 2: Opening Balance — generateOpeningBalance
 *
 * Mocks:
 *   - ../db/db  (sql tagged template)
 *   - fetch     (ERPNextClient HTTP calls)
 *
 * Covers: basic JE creation, idempotency (submitted / draft), P&L account
 * filtering, Depreciation account filtering, Temporary Opening balancing,
 * no balances → null, unmapped ledgers skipped, party accounts get party details.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { generateOpeningBalance } from './opening-balance'

// ── Mock DB ──────────────────────────────────────────────────────────────────

// postgres.js sql is a tagged template literal — we mock the module to return
// a jest-style spy that can be configured per-test.
let mockSqlRows: Record<string, unknown>[] = []

vi.mock('../db/db', () => {
    const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
        void strings
        void values
        return Promise.resolve(mockSqlRows)
    }
    sql.unsafe = sql
    return { sql }
})

// ── Mock fetch ───────────────────────────────────────────────────────────────

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

function ok(data: unknown) {
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ data }) })
}

function notFound() {
    return Promise.resolve({ ok: false, status: 404, json: async () => ({ message: 'Not found' }) })
}

// ── Base options ─────────────────────────────────────────────────────────────

const baseOpts = {
    companyId: 'test-co-id',
    erpnextCompany: 'Test Company',
    erpnextAbbr: 'TC',
    postingDate: '2023-04-01',
    accountMappings: {
        'Cash in Hand': 'Cash - TC',
        'Sundry Debtors': 'Debtors - TC',
        'Sundry Creditors': 'Creditors - TC',
        'Bank of Baroda': 'Bank - TC',
        'Capital Account': 'Capital Stock - TC',
        'Temporary Opening': 'Temporary Opening - TC',
    },
    costCenter: 'Main - TC',
    companyGstin: '33AABCT1234A1ZA',
    erpnextUrl: 'https://erp.example.com',
    erpnextApiKey: 'k',
    erpnextApiSecret: 's',
}

beforeEach(() => {
    vi.resetAllMocks()   // clears mockReturnValueOnce queues between tests
    mockSqlRows = []
})

// ── Tests ────────────────────────────────────────────────────────────────────

describe('generateOpeningBalance', () => {
    it('returns null when no opening balances exist in ledger_masters', async () => {
        // findByTallyGUID → null (no existing JE)
        mockFetch.mockReturnValueOnce(ok([])) // listDocs → no existing JE

        mockSqlRows = [] // no rows

        const result = await generateOpeningBalance(baseOpts)

        expect(result).toBeNull()
    })

    it('returns existing JE name when already submitted (idempotent)', async () => {
        // findByTallyGUID → found
        mockFetch
            .mockReturnValueOnce(ok([{ name: 'ACC-JV-2023-00001' }]))      // findByTallyGUID
            .mockReturnValueOnce(ok({ docstatus: 1, name: 'ACC-JV-2023-00001' })) // getDoc (check docstatus)

        mockSqlRows = [{ tally_name: 'Cash in Hand', opening_balance: 50000, ledger_type: 'Cash', is_party_ledger: false }]

        const result = await generateOpeningBalance(baseOpts)

        expect(result).toBe('ACC-JV-2023-00001')
        // No create/submit calls
        const urls = mockFetch.mock.calls.map((c: unknown[]) => c[0])
        expect(urls.every((u: string) => !u.includes('POST'))).toBe(true)
    })

    it('deletes stale draft JE and recreates', async () => {
        mockFetch
            .mockReturnValueOnce(ok([{ name: 'ACC-JV-2023-DRAFT' }]))   // findByTallyGUID
            .mockReturnValueOnce(ok({ docstatus: 0 }))                  // getDoc JE — draft
            .mockReturnValueOnce(ok(null))                              // deleteDoc
            // ensureGLAccount — both accounts already exist (found)
            .mockReturnValueOnce(ok({}))                                // ensureGLAccount Cash - TC
            .mockReturnValueOnce(ok({}))                                // ensureGLAccount Capital Stock - TC
            // account type filter
            .mockReturnValueOnce(ok({ account_type: 'Cash', root_type: 'Asset' }))    // Cash
            .mockReturnValueOnce(ok({ account_type: 'Equity', root_type: 'Equity' })) // Capital
            // balanced: dr=50000 cr=50000 → no Temporary Opening needed
            .mockReturnValueOnce(ok({ name: 'ACC-JV-2023-NEW' }))      // createDoc JE
            .mockReturnValueOnce(ok(null))                              // submitDoc

        mockSqlRows = [
            { tally_name: 'Cash in Hand', tally_group: 'Cash-in-Hand', opening_balance: 50000, ledger_type: 'Cash', is_party_ledger: false },
            { tally_name: 'Capital Account', tally_group: 'Capital Account', opening_balance: -50000, ledger_type: 'Equity', is_party_ledger: false },
        ]

        const result = await generateOpeningBalance(baseOpts)

        expect(result).toBe('ACC-JV-2023-NEW')
        // deleteDoc was called
        const deleteCalls = mockFetch.mock.calls.filter((c: unknown[]) => (c[1] as RequestInit).method === 'DELETE')
        expect(deleteCalls).toHaveLength(1)
    })

    it('creates a balanced JE from ledger_masters', async () => {
        mockFetch
            .mockReturnValueOnce(ok([]))                                 // findByTallyGUID → none
            // ensureGLAccount per account
            .mockReturnValueOnce(notFound())                             // getDoc Cash - TC
            .mockReturnValueOnce(ok({ name: 'Cash - TC' }))             // create Cash - TC
            .mockReturnValueOnce(notFound())                             // getDoc Debtors - TC
            .mockReturnValueOnce(ok({ name: 'Debtors - TC' }))          // create Debtors - TC
            .mockReturnValueOnce(notFound())                             // getDoc Capital Stock - TC
            .mockReturnValueOnce(ok({ name: 'Capital Stock - TC' }))    // create Capital Stock - TC
            // getDoc Account for type checking
            .mockReturnValueOnce(ok({ account_type: 'Cash', root_type: 'Asset' }))        // Cash
            .mockReturnValueOnce(ok({ account_type: 'Receivable', root_type: 'Asset' }))  // Debtors
            .mockReturnValueOnce(ok({ account_type: 'Equity', root_type: 'Equity' }))     // Capital
            // createDoc JE + submit
            .mockReturnValueOnce(ok({ name: 'ACC-JV-2023-00002' }))
            .mockReturnValueOnce(ok(null))

        mockSqlRows = [
            { tally_name: 'Cash in Hand', tally_group: 'Cash-in-Hand', opening_balance: 50000, ledger_type: 'Cash', is_party_ledger: false },
            { tally_name: 'Sundry Debtors', tally_group: 'Sundry Debtors', opening_balance: 30000, ledger_type: 'Customer', is_party_ledger: true },
            { tally_name: 'Capital Account', tally_group: 'Capital Account', opening_balance: -80000, ledger_type: 'Equity', is_party_ledger: false },
        ]

        const result = await generateOpeningBalance(baseOpts)

        expect(result).toBe('ACC-JV-2023-00002')

        // Find the createDoc JE call
        const postCalls = mockFetch.mock.calls.filter(
            (c: unknown[]) => (c[1] as RequestInit).method === 'POST' && (c[0] as string).includes('/Journal%20Entry')
        )
        expect(postCalls).toHaveLength(1)

        const jeBody = JSON.parse((postCalls[0][1] as RequestInit).body as string)
        expect(jeBody.voucher_type).toBe('Opening Entry')
        expect(jeBody.is_opening).toBe('Yes')
        expect(jeBody.company).toBe('Test Company')
        expect(jeBody.posting_date).toBe('2023-04-01')
        expect(jeBody.custom_tally_guid).toBe('opening-balance-test-co-id')
        expect(jeBody.total_debit).toBe(80000)
        expect(jeBody.total_credit).toBe(80000)

        // Party account should have party details
        const debtorLine = jeBody.accounts.find((a: { account: string }) => a.account === 'Debtors - TC')
        expect(debtorLine.party_type).toBe('Customer')
        expect(debtorLine.party).toBe('Sundry Debtors')
    })

    it('skips P&L accounts (Income/Expense) from opening entry', async () => {
        mockFetch
            .mockReturnValueOnce(ok([]))                                 // findByTallyGUID
            // ensureGLAccount
            .mockReturnValueOnce(notFound()).mockReturnValueOnce(ok({})) // Cash - TC
            .mockReturnValueOnce(notFound()).mockReturnValueOnce(ok({})) // Sales - TC
            // Account type checks
            .mockReturnValueOnce(ok({ account_type: 'Cash', root_type: 'Asset' }))
            .mockReturnValueOnce(ok({ account_type: null, root_type: 'Income' })) // Income → filtered
            // Balancing: Cash 50000 debit, Sales filtered → diff = 50000, need Temporary Opening credit
            .mockReturnValueOnce(notFound()).mockReturnValueOnce(ok({})) // ensureGLAccount Temporary Opening
            .mockReturnValueOnce(ok({ name: 'ACC-JV-2023-00003' }))
            .mockReturnValueOnce(ok(null))

        mockSqlRows = [
            { tally_name: 'Cash in Hand', tally_group: 'Cash-in-Hand', opening_balance: 50000, ledger_type: 'Cash', is_party_ledger: false },
            { tally_name: 'Capital Account', tally_group: 'Sales Income', opening_balance: -50000, ledger_type: 'Income', is_party_ledger: false },
        ]

        const opts = {
            ...baseOpts,
            accountMappings: {
                ...baseOpts.accountMappings,
                'Capital Account': 'Sales - TC',
            },
        }

        const result = await generateOpeningBalance(opts)
        expect(result).toBe('ACC-JV-2023-00003')

        // JE should have Temporary Opening as balancing entry
        const postCalls = mockFetch.mock.calls.filter(
            (c: unknown[]) => (c[1] as RequestInit).method === 'POST' && (c[0] as string).includes('/Journal%20Entry')
        )
        const jeBody = JSON.parse((postCalls[0][1] as RequestInit).body as string)
        const tempAccount = jeBody.accounts.find((a: { account: string }) => a.account.includes('Temporary Opening'))
        expect(tempAccount).toBeDefined()
        expect(tempAccount.credit_in_account_currency).toBe(50000)
    })

    it('skips Depreciation account type from opening entry', async () => {
        mockFetch
            .mockReturnValueOnce(ok([]))
            .mockReturnValueOnce(notFound()).mockReturnValueOnce(ok({})) // ensureGLAccount Cash
            .mockReturnValueOnce(notFound()).mockReturnValueOnce(ok({})) // ensureGLAccount Accum Depr
            // Account type checks
            .mockReturnValueOnce(ok({ account_type: 'Cash', root_type: 'Asset' }))
            .mockReturnValueOnce(ok({ account_type: 'Accumulated Depreciation', root_type: 'Asset' })) // Depreciation → filtered
            // Balancing
            .mockReturnValueOnce(notFound()).mockReturnValueOnce(ok({}))
            .mockReturnValueOnce(ok({ name: 'ACC-JV-DEP' }))
            .mockReturnValueOnce(ok(null))

        mockSqlRows = [
            { tally_name: 'Cash in Hand', tally_group: 'Cash-in-Hand', opening_balance: 100000, ledger_type: 'Cash', is_party_ledger: false },
            { tally_name: 'Bank of Baroda', tally_group: 'Accumulated Depreciation', opening_balance: -100000, ledger_type: 'Asset', is_party_ledger: false },
        ]

        const opts = {
            ...baseOpts,
            accountMappings: {
                ...baseOpts.accountMappings,
                'Bank of Baroda': 'Accumulated Depr - TC',
            },
        }

        const result = await generateOpeningBalance(opts)
        expect(result).toBe('ACC-JV-DEP')

        const postCalls = mockFetch.mock.calls.filter(
            (c: unknown[]) => (c[1] as RequestInit).method === 'POST' && (c[0] as string).includes('/Journal%20Entry')
        )
        const jeBody = JSON.parse((postCalls[0][1] as RequestInit).body as string)
        // Depreciation account should NOT be in accounts[]
        const deprLine = jeBody.accounts.find((a: { account: string }) => a.account.includes('Accumulated Depr'))
        expect(deprLine).toBeUndefined()
    })

    it('skips unmapped ledgers silently', async () => {
        mockFetch
            .mockReturnValueOnce(ok([]))
            // ensureGLAccount Cash - TC
            .mockReturnValueOnce(notFound()).mockReturnValueOnce(ok({}))
            // account type check
            .mockReturnValueOnce(ok({ account_type: 'Cash', root_type: 'Asset' }))
            // balancing (diff = 50000, need Temporary Opening)
            .mockReturnValueOnce(notFound()).mockReturnValueOnce(ok({}))
            .mockReturnValueOnce(ok({ name: 'ACC-JV-UNMAP' }))
            .mockReturnValueOnce(ok(null))

        mockSqlRows = [
            { tally_name: 'Cash in Hand', tally_group: 'Cash-in-Hand', opening_balance: 50000, ledger_type: 'Cash', is_party_ledger: false },
            { tally_name: 'UNKNOWN LEDGER', tally_group: 'Unknown', opening_balance: -50000, ledger_type: 'Other', is_party_ledger: false },
        ]

        const result = await generateOpeningBalance(baseOpts)
        expect(result).toBe('ACC-JV-UNMAP')
    })

    it('adds is_advance=No for Payable/Receivable account without party', async () => {
        mockFetch
            .mockReturnValueOnce(ok([]))
            .mockReturnValueOnce(notFound()).mockReturnValueOnce(ok({})) // ensureGLAccount Creditors
            .mockReturnValueOnce(notFound()).mockReturnValueOnce(ok({})) // ensureGLAccount Capital
            .mockReturnValueOnce(ok({ account_type: 'Payable', root_type: 'Liability' }))  // Creditors — no party
            .mockReturnValueOnce(ok({ account_type: 'Equity', root_type: 'Equity' }))       // Capital
            .mockReturnValueOnce(ok({ name: 'ACC-JV-ADV' }))
            .mockReturnValueOnce(ok(null))

        mockSqlRows = [
            { tally_name: 'Sundry Creditors', tally_group: 'Creditors', opening_balance: -40000, ledger_type: 'Liability', is_party_ledger: false },
            { tally_name: 'Capital Account', tally_group: 'Capital', opening_balance: 40000, ledger_type: 'Equity', is_party_ledger: false },
        ]

        // No party for Creditors (is_party_ledger=false, ledger_type != Customer/Supplier)
        const opts = {
            ...baseOpts,
            accountMappings: {
                'Sundry Creditors': 'Creditors - TC',
                'Capital Account': 'Capital Stock - TC',
                'Temporary Opening': 'Temporary Opening - TC',
            },
        }

        await generateOpeningBalance(opts)

        const postCalls = mockFetch.mock.calls.filter(
            (c: unknown[]) => (c[1] as RequestInit).method === 'POST' && (c[0] as string).includes('/Journal%20Entry')
        )
        const jeBody = JSON.parse((postCalls[0][1] as RequestInit).body as string)
        const creditorsLine = jeBody.accounts.find((a: { account: string }) => a.account === 'Creditors - TC')
        expect(creditorsLine?.is_advance).toBe('No')
    })

    it('uses Temporary Opening mapping from accountMappings if available', async () => {
        mockFetch
            .mockReturnValueOnce(ok([]))
            .mockReturnValueOnce(notFound()).mockReturnValueOnce(ok({}))  // Cash - TC
            .mockReturnValueOnce(ok({ account_type: 'Cash', root_type: 'Asset' }))
            // Balancing needed — should use mapped Temporary Opening
            .mockReturnValueOnce(notFound()).mockReturnValueOnce(ok({}))  // ensureGLAccount Temp Opening
            .mockReturnValueOnce(ok({ name: 'ACC-JV-TEMP' }))
            .mockReturnValueOnce(ok(null))

        mockSqlRows = [
            { tally_name: 'Cash in Hand', tally_group: 'Cash', opening_balance: 25000, ledger_type: 'Cash', is_party_ledger: false },
        ]

        const opts = {
            ...baseOpts,
            accountMappings: {
                'Cash in Hand': 'Cash - TC',
                'Temporary Opening': '1910 - Temporary Opening - TC',
            },
        }

        await generateOpeningBalance(opts)

        const postCalls = mockFetch.mock.calls.filter(
            (c: unknown[]) => (c[1] as RequestInit).method === 'POST' && (c[0] as string).includes('/Journal%20Entry')
        )
        const jeBody = JSON.parse((postCalls[0][1] as RequestInit).body as string)
        const tempLine = jeBody.accounts.find((a: { account: string }) => a.account.includes('Temporary Opening'))
        expect(tempLine.account).toBe('1910 - Temporary Opening - TC')
        expect(tempLine.credit_in_account_currency).toBe(25000)
    })

    it('submits the created JE', async () => {
        mockFetch
            .mockReturnValueOnce(ok([]))
            .mockReturnValueOnce(notFound()).mockReturnValueOnce(ok({}))  // ensureGLAccount
            .mockReturnValueOnce(ok({ account_type: 'Cash', root_type: 'Asset' }))
            .mockReturnValueOnce(notFound()).mockReturnValueOnce(ok({}))  // balancing
            .mockReturnValueOnce(ok({ name: 'ACC-JV-SUBMIT' }))         // createDoc
            .mockReturnValueOnce(ok(null))                               // submitDoc

        mockSqlRows = [
            { tally_name: 'Cash in Hand', tally_group: 'Cash', opening_balance: 10000, ledger_type: 'Cash', is_party_ledger: false },
        ]

        const result = await generateOpeningBalance(baseOpts)
        expect(result).toBe('ACC-JV-SUBMIT')

        // Last PUT call should be submit (docstatus=1)
        const putCalls = mockFetch.mock.calls.filter((c: unknown[]) => (c[1] as RequestInit).method === 'PUT')
        expect(putCalls.length).toBeGreaterThan(0)
        const lastPut = JSON.parse((putCalls[putCalls.length - 1][1] as RequestInit).body as string)
        expect(lastPut.docstatus).toBe(1)
    })
})
