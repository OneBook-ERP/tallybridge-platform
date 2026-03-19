import { useState, useEffect, useRef } from 'react'
import { apiFetch } from '../../lib/api'
import { useWebSocket } from '../../lib/useWebSocket'
import { useAuth } from '../../lib/auth'
import AdminManager from './admin-manager'
import SetupWizard from './setup-wizard'

interface Stats {
    synced: number
    errored: number
    pending: number
    conflicts: number
    openExceptions: number
}

interface DataRow {
    label: string
    doctype: string
    tallySynced: number
    erpnextCount: number
    tallyCount?: number
}

interface DataComparison {
    comparison: DataRow[]
    exceptions: Record<string, number>
    totalTallySynced: number
    totalErpNext: number
    tallyCountsRaw?: Record<string, number> | null
    tallyCountsUpdatedAt?: string | null
}

interface SyncRecord {
    tally_guid: string
    erpnext_doctype: string
    erpnext_name: string
    sync_status: string
    last_synced_at: string
}

interface Exception {
    id: string
    tier: string
    document_ref: string
    error_code: string
    error_message: string
    created_at: string
    resolved_at: string | null
}

interface Company {
    id: string
    tally_company_name: string
    erpnext_company: string
    last_heartbeat_at: string | null
}

interface WsMessage {
    event: string
    data: Record<string, unknown>
}

interface ConfigProfile {
    abbr: string
    accountMappings: Record<string, string>
    gstLedgerMappings: Record<string, string>
    voucherTypeMappings: Record<string, string>
    godownWarehouseMappings: Record<string, string>
    groupDefaultMappings: Record<string, string>
}

// Root-type classification for Tally groups — mirrors default-mappings.ts on the backend.
const TALLY_GROUP_ROOT_TYPE: Record<string, 'Asset' | 'Liability' | 'Income' | 'Expense'> = {
    'Sundry Debtors': 'Asset',
    'Bank Accounts': 'Asset',
    'Cash-in-Hand': 'Asset',
    'Loans & Advances (Asset)': 'Asset',
    'Fixed Assets': 'Asset',
    'Current Assets': 'Asset',
    'Stock-in-Hand': 'Asset',
    Investments: 'Asset',
    'Sundry Creditors': 'Liability',
    'Duties & Taxes': 'Liability',
    'Current Liabilities': 'Liability',
    'Loans & Advances (Liability)': 'Liability',
    Provisions: 'Liability',
    'Bank OD Accounts': 'Liability',
    'Sales Accounts': 'Income',
    'Direct Income': 'Income',
    'Indirect Income': 'Income',
    'Purchase Accounts': 'Expense',
    'Direct Expenses': 'Expense',
    'Indirect Expenses': 'Expense',
}

// Section metadata for the 4 grouping tabs
const ACCOUNT_SECTIONS = [
    { key: 'Asset', label: 'Assets', color: 'bg-blue-50 text-blue-700 border-blue-200' },
    { key: 'Liability', label: 'Liabilities', color: 'bg-purple-50 text-purple-700 border-purple-200' },
    { key: 'Income', label: 'Income', color: 'bg-green-50 text-green-700 border-green-200' },
    { key: 'Expense', label: 'Expenses', color: 'bg-orange-50 text-orange-700 border-orange-200' },
] as const

interface GodownRow {
    tallyGodown: string
    erpnextWarehouse: string
    mapped: boolean
}

// ---------------------------------------------------------------------------
// Configuration Tab component
// ---------------------------------------------------------------------------

const ERP_DOCTYPES = ['Sales Invoice', 'Purchase Invoice', 'Payment Entry', 'Journal Entry', 'Stock Entry']

function ConfigurationTab({ companyId }: { companyId: string }) {
    const [activeSection, setActiveSection] = useState<'accounts' | 'gst' | 'vouchers' | 'godowns'>('accounts')
    const [configLoading, setConfigLoading] = useState(false)
    const [configError, setConfigError] = useState<string | null>(null)

    // Account mappings state
    const [accountRows, setAccountRows] = useState<{ tally: string; erp: string }[]>([])
    const [accountSaving, setAccountSaving] = useState(false)
    const [accountSaveMsg, setAccountSaveMsg] = useState<string | null>(null)
    const [groupDefaultMappings, setGroupDefaultMappings] = useState<Record<string, string>>({})
    const [activeRootType, setActiveRootType] = useState<'Asset' | 'Liability' | 'Income' | 'Expense' | 'All'>('All')

    // GST mappings state
    const [gstFields, setGstFields] = useState({
        output_cgst: '',
        output_sgst: '',
        output_igst: '',
        input_cgst: '',
        input_sgst: '',
        input_igst: '',
    })
    const [gstSaving, setGstSaving] = useState(false)
    const [gstSaveMsg, setGstSaveMsg] = useState<string | null>(null)

    // Voucher type mappings state
    const [voucherRows, setVoucherRows] = useState<{ tally: string; erp: string }[]>([])
    const [voucherSaving, setVoucherSaving] = useState(false)
    const [voucherSaveMsg, setVoucherSaveMsg] = useState<string | null>(null)

    // Godown mappings state
    const [godowns, setGodowns] = useState<GodownRow[]>([])
    const [godownEdits, setGodownEdits] = useState<Record<string, string>>({})
    const [godownSaving, setGodownSaving] = useState(false)
    const [godownSaveMsg, setGodownSaveMsg] = useState<string | null>(null)
    const [godownLoading, setGodownLoading] = useState(false)

    useEffect(() => {
        if (!companyId) return
        setConfigLoading(true)
        setConfigError(null)
        apiFetch<ConfigProfile>(`/dashboard/config?companyId=${companyId}`)
            .then((cfg) => {
                // Populate account rows (manual mappings only)
                setAccountRows(
                    Object.entries(cfg.accountMappings || {}).map(([tally, erp]) => ({ tally, erp: erp as string })),
                )
                setGroupDefaultMappings(cfg.groupDefaultMappings || {})
                // Populate GST fields
                const gm = cfg.gstLedgerMappings || {}
                setGstFields({
                    output_cgst: (gm['output_cgst'] as string) || '',
                    output_sgst: (gm['output_sgst'] as string) || '',
                    output_igst: (gm['output_igst'] as string) || '',
                    input_cgst: (gm['input_cgst'] as string) || '',
                    input_sgst: (gm['input_sgst'] as string) || '',
                    input_igst: (gm['input_igst'] as string) || '',
                })
                // Populate voucher rows
                setVoucherRows(
                    Object.entries(cfg.voucherTypeMappings || {}).map(([tally, erp]) => ({
                        tally,
                        erp: erp as string,
                    })),
                )
                // Populate godown edits from config
                setGodownEdits(cfg.godownWarehouseMappings || {})
            })
            .catch((err) => {
                // 404 means endpoint not yet implemented — show empty state, don't error
                if (!err.message?.includes('404')) {
                    setConfigError(err.message)
                }
            })
            .finally(() => setConfigLoading(false))
    }, [companyId])

    useEffect(() => {
        if (!companyId || activeSection !== 'godowns') return
        setGodownLoading(true)
        apiFetch<{ godowns: GodownRow[] }>(`/dashboard/godowns?companyId=${companyId}`)
            .then((res) => {
                setGodowns(res.godowns)
                // Pre-fill edits with existing mappings
                const edits: Record<string, string> = {}
                for (const g of res.godowns) {
                    if (g.erpnextWarehouse) edits[g.tallyGodown] = g.erpnextWarehouse
                }
                setGodownEdits((prev) => ({ ...edits, ...prev }))
            })
            .catch(() => {})
            .finally(() => setGodownLoading(false))
    }, [companyId, activeSection])

    async function saveAccountMappings() {
        setAccountSaving(true)
        setAccountSaveMsg(null)
        try {
            const accountMappings: Record<string, string> = {}
            for (const row of accountRows) {
                if (row.tally.trim()) accountMappings[row.tally.trim()] = row.erp.trim()
            }
            await apiFetch('/dashboard/config', {
                method: 'PATCH',
                body: JSON.stringify({ companyId, accountMappings }),
            })
            setAccountSaveMsg('Account mappings saved.')
        } catch (e) {
            setAccountSaveMsg('Error: ' + (e instanceof Error ? e.message : String(e)))
        }
        setAccountSaving(false)
    }

    async function saveGstMappings() {
        setGstSaving(true)
        setGstSaveMsg(null)
        try {
            await apiFetch('/dashboard/config', {
                method: 'PATCH',
                body: JSON.stringify({ companyId, gstLedgerMappings: gstFields }),
            })
            setGstSaveMsg('GST mappings saved.')
        } catch (e) {
            setGstSaveMsg('Error: ' + (e instanceof Error ? e.message : String(e)))
        }
        setGstSaving(false)
    }

    async function saveVoucherMappings() {
        setVoucherSaving(true)
        setVoucherSaveMsg(null)
        try {
            const voucherTypeMappings: Record<string, string> = {}
            for (const row of voucherRows) {
                if (row.tally.trim()) voucherTypeMappings[row.tally.trim()] = row.erp
            }
            await apiFetch('/dashboard/config', {
                method: 'PATCH',
                body: JSON.stringify({ companyId, voucherTypeMappings }),
            })
            setVoucherSaveMsg('Voucher type mappings saved.')
        } catch (e) {
            setVoucherSaveMsg('Error: ' + (e instanceof Error ? e.message : String(e)))
        }
        setVoucherSaving(false)
    }

    async function saveGodownMappings() {
        setGodownSaving(true)
        setGodownSaveMsg(null)
        try {
            await apiFetch('/dashboard/config', {
                method: 'PATCH',
                body: JSON.stringify({ companyId, godownWarehouseMappings: godownEdits }),
            })
            setGodownSaveMsg('Warehouse mappings saved.')
        } catch (e) {
            setGodownSaveMsg('Error: ' + (e instanceof Error ? e.message : String(e)))
        }
        setGodownSaving(false)
    }

    const sections = [
        { id: 'accounts', label: 'Account Mappings' },
        { id: 'gst', label: 'GST Ledgers' },
        { id: 'vouchers', label: 'Voucher Types' },
        { id: 'godowns', label: 'Godown → Warehouse' },
    ] as const

    if (configLoading) {
        return (
            <div className="bg-white rounded-xl shadow-sm border p-8 text-center text-gray-400">
                Loading configuration...
            </div>
        )
    }

    if (configError) {
        return (
            <div className="bg-white rounded-xl shadow-sm border p-8 text-center text-red-500">
                Failed to load config: {configError}
            </div>
        )
    }

    return (
        <div className="flex gap-6">
            {/* Left sidebar navigation */}
            <div className="w-48 shrink-0">
                <nav className="bg-white rounded-xl shadow-sm border p-2 space-y-1">
                    {sections.map((s) => (
                        <button
                            key={s.id}
                            onClick={() => setActiveSection(s.id)}
                            className={`w-full text-left px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                                activeSection === s.id
                                    ? 'bg-blue-50 text-blue-700'
                                    : 'text-gray-600 hover:bg-gray-50 hover:text-gray-900'
                            }`}
                        >
                            {s.label}
                        </button>
                    ))}
                </nav>
            </div>

            {/* Section content */}
            <div className="flex-1 min-w-0">
                {/* A. Account Mappings — grouped by root type */}
                {activeSection === 'accounts' && (
                    <div className="space-y-4">
                        {/* Header */}
                        <div className="bg-white rounded-xl shadow-sm border p-5">
                            <div className="flex items-start justify-between gap-4">
                                <div>
                                    <h3 className="font-semibold text-lg">Account Mappings</h3>
                                    <p className="text-sm text-gray-500 mt-0.5">
                                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-emerald-50 text-emerald-700 border border-emerald-200 mr-1">
                                            Auto
                                        </span>
                                        group defaults resolve automatically.
                                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-slate-100 text-slate-600 border border-slate-200 mx-1">
                                            Manual
                                        </span>
                                        entries override or extend defaults.
                                    </p>
                                </div>
                                <button
                                    onClick={() => setAccountRows((prev) => [...prev, { tally: '', erp: '' }])}
                                    className="shrink-0 px-3 py-1.5 text-sm font-medium bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
                                >
                                    + Add Mapping
                                </button>
                            </div>

                            {/* Root-type filter tabs */}
                            <div className="flex gap-2 mt-4 flex-wrap">
                                {(['All', ...ACCOUNT_SECTIONS.map((s) => s.key)] as const).map((rt) => (
                                    <button
                                        key={rt}
                                        onClick={() => setActiveRootType(rt as typeof activeRootType)}
                                        className={`px-3 py-1 text-xs font-medium rounded-full border transition-colors ${
                                            activeRootType === rt
                                                ? 'bg-blue-600 text-white border-blue-600'
                                                : 'bg-white text-gray-600 border-gray-300 hover:border-gray-400'
                                        }`}
                                    >
                                        {rt === 'All' ? 'All' : ACCOUNT_SECTIONS.find((s) => s.key === rt)?.label}
                                        {rt !== 'All' && (
                                            <span className="ml-1 text-xs opacity-70">
                                                (
                                                {
                                                    accountRows.filter(
                                                        (r) => (TALLY_GROUP_ROOT_TYPE[r.tally] ?? 'Expense') === rt,
                                                    ).length
                                                }
                                                )
                                            </span>
                                        )}
                                    </button>
                                ))}
                            </div>
                        </div>

                        {/* Auto-matched group defaults — read-only, collapsible */}
                        {Object.keys(groupDefaultMappings).length > 0 && (
                            <details className="bg-emerald-50 rounded-xl border border-emerald-200 p-4 open:space-y-3">
                                <summary className="cursor-pointer font-medium text-sm text-emerald-800 select-none flex items-center gap-2">
                                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-emerald-100 text-emerald-700 border border-emerald-300">
                                        Auto
                                    </span>
                                    Group Defaults — {Object.keys(groupDefaultMappings).length} auto-matched accounts
                                    <span className="text-xs text-emerald-600 ml-auto font-normal">
                                        no configuration needed ▾
                                    </span>
                                </summary>
                                <table className="min-w-full text-sm mt-2">
                                    <thead>
                                        <tr className="text-xs text-emerald-700 uppercase">
                                            <th className="py-1 pr-4 text-left font-semibold">Tally Group</th>
                                            <th className="py-1 text-left font-semibold">ERPNext Account</th>
                                        </tr>
                                    </thead>
                                    <tbody className="divide-y divide-emerald-100">
                                        {Object.entries(groupDefaultMappings)
                                            .filter(
                                                ([group]) =>
                                                    activeRootType === 'All' ||
                                                    TALLY_GROUP_ROOT_TYPE[group] === activeRootType,
                                            )
                                            .map(([group, account]) => (
                                                <tr key={group}>
                                                    <td className="py-1.5 pr-4 text-emerald-900 font-medium">
                                                        {group}
                                                    </td>
                                                    <td className="py-1.5 text-emerald-800">{account}</td>
                                                </tr>
                                            ))}
                                    </tbody>
                                </table>
                            </details>
                        )}

                        {/* Manual mappings — editable table */}
                        <div className="bg-white rounded-xl shadow-sm border p-5 space-y-3">
                            <h4 className="font-medium text-sm text-gray-700 flex items-center gap-2">
                                <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-slate-100 text-slate-600 border border-slate-200">
                                    Manual
                                </span>
                                Specific Ledger Mappings
                                <span className="text-xs text-gray-400 font-normal">
                                    — override or extend group defaults
                                </span>
                            </h4>

                            {accountRows.filter(
                                (r) =>
                                    activeRootType === 'All' ||
                                    (TALLY_GROUP_ROOT_TYPE[r.tally] ?? 'Expense') === activeRootType,
                            ).length === 0 ? (
                                <div className="py-6 text-center text-gray-400 text-sm border rounded-lg">
                                    {activeRootType === 'All'
                                        ? 'No manual mappings yet. Click "+ Add Mapping" to add one.'
                                        : `No ${ACCOUNT_SECTIONS.find((s) => s.key === activeRootType)?.label.toLowerCase()} mappings yet.`}
                                </div>
                            ) : (
                                <div className="overflow-x-auto">
                                    <table className="min-w-full divide-y divide-gray-200">
                                        <thead className="bg-gray-50">
                                            <tr>
                                                <th className="px-4 py-2 text-left text-xs font-semibold text-gray-500 uppercase w-10">
                                                    Type
                                                </th>
                                                <th className="px-4 py-2 text-left text-xs font-semibold text-gray-500 uppercase">
                                                    Tally Ledger
                                                </th>
                                                <th className="px-4 py-2 text-left text-xs font-semibold text-gray-500 uppercase">
                                                    ERPNext Account
                                                </th>
                                                <th className="px-4 py-2 w-16"></th>
                                            </tr>
                                        </thead>
                                        <tbody className="bg-white divide-y divide-gray-100">
                                            {accountRows.map((row, i) => {
                                                const rootType = TALLY_GROUP_ROOT_TYPE[row.tally] ?? 'Expense'
                                                if (activeRootType !== 'All' && rootType !== activeRootType) return null
                                                const sec = ACCOUNT_SECTIONS.find((s) => s.key === rootType)
                                                return (
                                                    <tr key={i}>
                                                        <td className="px-4 py-2">
                                                            {sec && (
                                                                <span
                                                                    className={`inline-block px-1.5 py-0.5 rounded text-xs font-medium border ${sec.color}`}
                                                                >
                                                                    {sec.label.slice(0, 3)}
                                                                </span>
                                                            )}
                                                        </td>
                                                        <td className="px-4 py-2">
                                                            <input
                                                                type="text"
                                                                value={row.tally}
                                                                onChange={(e) =>
                                                                    setAccountRows((prev) => {
                                                                        const next = [...prev]
                                                                        next[i] = { ...next[i], tally: e.target.value }
                                                                        return next
                                                                    })
                                                                }
                                                                placeholder="Tally ledger name"
                                                                className="w-full px-2 py-1.5 border rounded text-sm"
                                                            />
                                                        </td>
                                                        <td className="px-4 py-2">
                                                            <input
                                                                type="text"
                                                                value={row.erp}
                                                                onChange={(e) =>
                                                                    setAccountRows((prev) => {
                                                                        const next = [...prev]
                                                                        next[i] = { ...next[i], erp: e.target.value }
                                                                        return next
                                                                    })
                                                                }
                                                                placeholder="ERPNext account name"
                                                                className="w-full px-2 py-1.5 border rounded text-sm"
                                                            />
                                                        </td>
                                                        <td className="px-4 py-2">
                                                            <button
                                                                onClick={() =>
                                                                    setAccountRows((prev) =>
                                                                        prev.filter((_, j) => j !== i),
                                                                    )
                                                                }
                                                                className="text-red-400 hover:text-red-600 text-xs"
                                                            >
                                                                Remove
                                                            </button>
                                                        </td>
                                                    </tr>
                                                )
                                            })}
                                        </tbody>
                                    </table>
                                </div>
                            )}

                            <div className="flex items-center gap-3 pt-1">
                                <button
                                    onClick={saveAccountMappings}
                                    disabled={accountSaving}
                                    className="px-4 py-2 text-sm font-medium bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors"
                                >
                                    {accountSaving ? 'Saving...' : 'Save Changes'}
                                </button>
                                {accountSaveMsg && (
                                    <span
                                        className={`text-sm ${accountSaveMsg.startsWith('Error') ? 'text-red-600' : 'text-green-600'}`}
                                    >
                                        {accountSaveMsg}
                                    </span>
                                )}
                            </div>
                        </div>
                    </div>
                )}

                {/* B. GST Ledger Mappings */}
                {activeSection === 'gst' && (
                    <div className="bg-white rounded-xl shadow-sm border p-6 space-y-5">
                        <div>
                            <h3 className="font-semibold text-lg">GST Ledger Mappings</h3>
                            <p className="text-sm text-gray-500 mt-0.5">
                                Map Tally GST ledgers to ERPNext tax accounts.
                            </p>
                        </div>

                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            {(
                                [
                                    { key: 'output_cgst', label: 'Output CGST' },
                                    { key: 'output_sgst', label: 'Output SGST' },
                                    { key: 'output_igst', label: 'Output IGST' },
                                    { key: 'input_cgst', label: 'Input CGST' },
                                    { key: 'input_sgst', label: 'Input SGST' },
                                    { key: 'input_igst', label: 'Input IGST' },
                                ] as { key: keyof typeof gstFields; label: string }[]
                            ).map(({ key, label }) => (
                                <div key={key}>
                                    <label className="block text-xs font-medium text-gray-600 mb-1">{label}</label>
                                    <input
                                        type="text"
                                        value={gstFields[key]}
                                        onChange={(e) => setGstFields((prev) => ({ ...prev, [key]: e.target.value }))}
                                        placeholder="ERPNext account name"
                                        className="w-full px-3 py-2 border rounded-lg text-sm"
                                    />
                                </div>
                            ))}
                        </div>

                        <div className="flex items-center gap-3">
                            <button
                                onClick={saveGstMappings}
                                disabled={gstSaving}
                                className="px-4 py-2 text-sm font-medium bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors"
                            >
                                {gstSaving ? 'Saving...' : 'Save GST Mappings'}
                            </button>
                            {gstSaveMsg && (
                                <span
                                    className={`text-sm ${gstSaveMsg.startsWith('Error') ? 'text-red-600' : 'text-green-600'}`}
                                >
                                    {gstSaveMsg}
                                </span>
                            )}
                        </div>
                    </div>
                )}

                {/* C. Voucher Type Mappings */}
                {activeSection === 'vouchers' && (
                    <div className="bg-white rounded-xl shadow-sm border p-6 space-y-4">
                        <div className="flex items-center justify-between">
                            <div>
                                <h3 className="font-semibold text-lg">Voucher Type Mappings</h3>
                                <p className="text-sm text-gray-500 mt-0.5">
                                    Map Tally voucher types to ERPNext doctypes.
                                </p>
                            </div>
                            <button
                                onClick={() => setVoucherRows((prev) => [...prev, { tally: '', erp: 'Journal Entry' }])}
                                className="px-3 py-1.5 text-sm font-medium bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
                            >
                                + Add Row
                            </button>
                        </div>

                        {voucherRows.length === 0 ? (
                            <div className="py-8 text-center text-gray-400 text-sm border rounded-lg">
                                No voucher type mappings configured.
                            </div>
                        ) : (
                            <div className="overflow-x-auto">
                                <table className="min-w-full divide-y divide-gray-200">
                                    <thead className="bg-gray-50">
                                        <tr>
                                            <th className="px-4 py-2 text-left text-xs font-semibold text-gray-500 uppercase">
                                                Tally Voucher Type
                                            </th>
                                            <th className="px-4 py-2 text-left text-xs font-semibold text-gray-500 uppercase">
                                                ERPNext Doctype
                                            </th>
                                            <th className="px-4 py-2 w-12"></th>
                                        </tr>
                                    </thead>
                                    <tbody className="bg-white divide-y divide-gray-100">
                                        {voucherRows.map((row, i) => (
                                            <tr key={i}>
                                                <td className="px-4 py-2">
                                                    <input
                                                        type="text"
                                                        value={row.tally}
                                                        onChange={(e) =>
                                                            setVoucherRows((prev) => {
                                                                const next = [...prev]
                                                                next[i] = { ...next[i], tally: e.target.value }
                                                                return next
                                                            })
                                                        }
                                                        placeholder="e.g. Sales"
                                                        className="w-full px-2 py-1.5 border rounded text-sm"
                                                    />
                                                </td>
                                                <td className="px-4 py-2">
                                                    <select
                                                        value={row.erp}
                                                        onChange={(e) =>
                                                            setVoucherRows((prev) => {
                                                                const next = [...prev]
                                                                next[i] = { ...next[i], erp: e.target.value }
                                                                return next
                                                            })
                                                        }
                                                        className="w-full px-2 py-1.5 border rounded text-sm"
                                                    >
                                                        {ERP_DOCTYPES.map((d) => (
                                                            <option key={d} value={d}>
                                                                {d}
                                                            </option>
                                                        ))}
                                                    </select>
                                                </td>
                                                <td className="px-4 py-2">
                                                    <button
                                                        onClick={() =>
                                                            setVoucherRows((prev) => prev.filter((_, j) => j !== i))
                                                        }
                                                        className="text-red-400 hover:text-red-600 text-xs"
                                                    >
                                                        Remove
                                                    </button>
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        )}

                        <div className="flex items-center gap-3">
                            <button
                                onClick={saveVoucherMappings}
                                disabled={voucherSaving}
                                className="px-4 py-2 text-sm font-medium bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors"
                            >
                                {voucherSaving ? 'Saving...' : 'Save Voucher Mappings'}
                            </button>
                            {voucherSaveMsg && (
                                <span
                                    className={`text-sm ${voucherSaveMsg.startsWith('Error') ? 'text-red-600' : 'text-green-600'}`}
                                >
                                    {voucherSaveMsg}
                                </span>
                            )}
                        </div>
                    </div>
                )}

                {/* D. Godown → Warehouse Mappings */}
                {activeSection === 'godowns' && (
                    <div className="bg-white rounded-xl shadow-sm border p-6 space-y-4">
                        <div>
                            <h3 className="font-semibold text-lg">Godown → Warehouse Mappings</h3>
                            <p className="text-sm text-gray-500 mt-0.5">
                                Map Tally godowns to ERPNext warehouses. Unmapped rows are highlighted.
                            </p>
                        </div>

                        {godownLoading ? (
                            <div className="py-8 text-center text-gray-400 text-sm">Loading godowns...</div>
                        ) : godowns.length === 0 ? (
                            <div className="py-8 text-center text-gray-400 text-sm border rounded-lg">
                                No godowns found. Sync master data from the connector first.
                            </div>
                        ) : (
                            <div className="overflow-x-auto">
                                <table className="min-w-full divide-y divide-gray-200">
                                    <thead className="bg-gray-50">
                                        <tr>
                                            <th className="px-4 py-2 text-left text-xs font-semibold text-gray-500 uppercase">
                                                Tally Godown
                                            </th>
                                            <th className="px-4 py-2 text-left text-xs font-semibold text-gray-500 uppercase">
                                                ERPNext Warehouse
                                            </th>
                                        </tr>
                                    </thead>
                                    <tbody className="divide-y divide-gray-100">
                                        {godowns.map((g) => {
                                            const currentVal = godownEdits[g.tallyGodown] ?? ''
                                            const isMapped = currentVal.trim().length > 0
                                            return (
                                                <tr key={g.tallyGodown} className={isMapped ? '' : 'bg-amber-50'}>
                                                    <td className="px-4 py-2 text-sm text-gray-800 font-medium">
                                                        {g.tallyGodown}
                                                        {!isMapped && (
                                                            <span className="ml-2 text-xs text-amber-600 font-normal">
                                                                unmapped
                                                            </span>
                                                        )}
                                                    </td>
                                                    <td className="px-4 py-2">
                                                        <input
                                                            type="text"
                                                            value={currentVal}
                                                            onChange={(e) =>
                                                                setGodownEdits((prev) => ({
                                                                    ...prev,
                                                                    [g.tallyGodown]: e.target.value,
                                                                }))
                                                            }
                                                            placeholder="ERPNext warehouse name"
                                                            className="w-full px-2 py-1.5 border rounded text-sm"
                                                        />
                                                    </td>
                                                </tr>
                                            )
                                        })}
                                    </tbody>
                                </table>
                            </div>
                        )}

                        <div className="flex items-center gap-3">
                            <button
                                onClick={saveGodownMappings}
                                disabled={godownSaving}
                                className="px-4 py-2 text-sm font-medium bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors"
                            >
                                {godownSaving ? 'Saving...' : 'Save Warehouse Mappings'}
                            </button>
                            {godownSaveMsg && (
                                <span
                                    className={`text-sm ${godownSaveMsg.startsWith('Error') ? 'text-red-600' : 'text-green-600'}`}
                                >
                                    {godownSaveMsg}
                                </span>
                            )}
                        </div>
                    </div>
                )}
            </div>
        </div>
    )
}

// ---------------------------------------------------------------------------
// Inline exception row with fix actions (Task 2)
// ---------------------------------------------------------------------------

function ExceptionRow({ exc, companyId, onResolved }: { exc: Exception; companyId: string; onResolved: () => void }) {
    const [mapAccount, setMapAccount] = useState('')
    const [saving, setSaving] = useState(false)
    const [retrying, setRetrying] = useState(false)

    // Extract ledger name from error message for UNMAPPED_LEDGER
    const ledgerMatch = /Tally ledger "([^"]+)"/.exec(exc.error_message)
    const ledgerName = ledgerMatch ? ledgerMatch[1] : null

    const tierBadge = (() => {
        if (exc.tier === 'TIER3_BLOCK')
            return (
                <span className="px-2 py-0.5 text-xs font-bold bg-red-100 text-red-800 rounded border border-red-200">
                    Blocked
                </span>
            )
        if (exc.tier === 'TIER2_FLAG')
            return (
                <span className="px-2 py-0.5 text-xs font-bold bg-orange-100 text-orange-800 rounded border border-orange-200">
                    Failed
                </span>
            )
        return (
            <span className="px-2 py-0.5 text-xs font-bold bg-gray-100 text-gray-600 rounded border border-gray-200">
                Info
            </span>
        )
    })()

    async function handleSaveAndRetry() {
        if (!ledgerName || !mapAccount.trim()) return
        setSaving(true)
        try {
            await apiFetch('/dashboard/config', {
                method: 'PATCH',
                body: JSON.stringify({
                    companyId,
                    accountMappings: { [ledgerName]: mapAccount.trim() },
                }),
            })
            await apiFetch('/dashboard/reprocess-exceptions', {
                method: 'POST',
                body: JSON.stringify({ companyId, exceptionIds: [exc.id] }),
            })
            onResolved()
        } catch {
            /* ignore */
        }
        setSaving(false)
    }

    async function handleRetry() {
        setRetrying(true)
        try {
            await apiFetch('/dashboard/reprocess-exceptions', {
                method: 'POST',
                body: JSON.stringify({ companyId, exceptionIds: [exc.id] }),
            })
            onResolved()
        } catch {
            /* ignore */
        }
        setRetrying(false)
    }

    return (
        <div className="bg-white rounded-xl shadow-sm border border-red-100 p-4">
            <div className="space-y-2">
                <div className="flex items-center space-x-3 flex-wrap gap-y-1">
                    {tierBadge}
                    <span className="text-xs font-mono text-slate-600">{exc.error_code}</span>
                    {exc.document_ref && <span className="text-xs text-gray-400 font-mono">{exc.document_ref}</span>}
                    <span className="text-xs text-gray-400">{new Date(exc.created_at).toLocaleString()}</span>
                </div>
                <div className="text-sm text-slate-700 bg-slate-50 p-2.5 rounded-lg border">{exc.error_message}</div>

                {/* UNMAPPED_LEDGER: inline map input */}
                {exc.error_code === 'UNMAPPED_LEDGER' && ledgerName && (
                    <div className="flex items-center gap-2 mt-2 flex-wrap">
                        <span className="text-xs text-gray-500 font-medium">Map &quot;{ledgerName}&quot; to:</span>
                        <input
                            type="text"
                            value={mapAccount}
                            onChange={(e) => setMapAccount(e.target.value)}
                            placeholder="ERPNext account name"
                            className="px-2 py-1.5 border rounded text-sm w-64"
                        />
                        <button
                            onClick={handleSaveAndRetry}
                            disabled={saving || !mapAccount.trim()}
                            className="px-3 py-1.5 text-sm font-medium bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50 transition-colors"
                        >
                            {saving ? 'Saving...' : 'Save & Retry'}
                        </button>
                    </div>
                )}

                {/* ERPNEXT_WRITE_FAILED or MASTER_CREATE_FAILED: retry button */}
                {(exc.error_code === 'ERPNEXT_WRITE_FAILED' || exc.error_code === 'MASTER_CREATE_FAILED') && (
                    <div className="mt-2">
                        <button
                            onClick={handleRetry}
                            disabled={retrying}
                            className="px-3 py-1.5 text-sm font-medium bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors"
                        >
                            {retrying ? 'Retrying...' : 'Retry'}
                        </button>
                    </div>
                )}
            </div>
        </div>
    )
}

// ---------------------------------------------------------------------------
// Main Dashboard
// ---------------------------------------------------------------------------

export default function CloudDashboard() {
    const { admin, logout } = useAuth()
    const [activeTab, setActiveTab] = useState('overview')
    const [companies, setCompanies] = useState<Company[]>([])
    const [selectedCompanyId, setSelectedCompanyId] = useState<string>('')
    const [stats, setStats] = useState<Stats | null>(null)
    const [records, setRecords] = useState<SyncRecord[]>([])
    const [exceptions, setExceptions] = useState<Exception[]>([])
    const [connectorOnline, setConnectorOnline] = useState(false)
    const [dataComparison, setDataComparison] = useState<DataComparison | null>(null)
    const [dataLoading, setDataLoading] = useState(false)
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)
    const [resetting, setResetting] = useState(false)
    const [resetIncludeMasters, setResetIncludeMasters] = useState(false)
    const [reprocessing, setReprocessing] = useState<string | null>(null)
    const [openingStockLoading, setOpeningStockLoading] = useState(false)
    const [openingStockDate, setOpeningStockDate] = useState('2023-04-01')
    const [openingStockResult, setOpeningStockResult] = useState<{ ok: boolean; message: string } | null>(null)
    const [cloudHealth, setCloudHealth] = useState<{ db: string; redis: string } | null>(null)
    const [syncProgress, setSyncProgress] = useState<{ synced: number; errored: number; active: boolean } | null>(null)
    const [retryAllLoading, setRetryAllLoading] = useState(false)
    const prevSyncedRef = useRef<number>(-1)
    const syncProgressTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
    // Pagination for Exceptions and Activity Log
    const [exceptionOffset, setExceptionOffset] = useState(0)
    const [exceptionTotal, setExceptionTotal] = useState(0)
    const [recordOffset, setRecordOffset] = useState(0)
    const [recordTotal, setRecordTotal] = useState(0)
    const PAGE_SIZE = 50

    async function handleResetSync() {
        const mastersWarning = resetIncludeMasters
            ? '\n\nWARNING: Master data (stock items, ledgers) will also be cleared.\nYou must re-sync the connector before using Sync Opening Stock.'
            : ''
        if (
            !confirm(
                `This will delete all sync records and exceptions for this company.\nAccount mappings and config are preserved.${mastersWarning}\n\nContinue?`,
            )
        )
            return
        setResetting(true)
        try {
            const qs = new URLSearchParams()
            if (selectedCompanyId) qs.set('companyId', selectedCompanyId)
            if (resetIncludeMasters) qs.set('includeMasters', 'true')
            await apiFetch(`/dashboard/reset-sync?${qs}`, { method: 'POST' })
            setStats(null)
            setRecords([])
            setExceptions([])
            setDataComparison(null)
            if (selectedCompanyId) {
                apiFetch<Stats>(`/dashboard/stats?companyId=${selectedCompanyId}`)
                    .then(setStats)
                    .catch(() => {})
            }
        } finally {
            setResetting(false)
        }
    }

    async function refreshExceptions(offset = exceptionOffset) {
        if (!selectedCompanyId) return
        try {
            const e = await apiFetch<{ exceptions: Exception[]; total: number }>(
                `/dashboard/exceptions?companyId=${selectedCompanyId}&limit=${PAGE_SIZE}&offset=${offset}`,
            )
            setExceptions(e.exceptions)
            setExceptionTotal(e.total ?? 0)
        } catch {
            /* ignore */
        }
    }

    async function refreshRecords(offset = recordOffset) {
        if (!selectedCompanyId) return
        try {
            const r = await apiFetch<{ records: SyncRecord[]; total?: number }>(
                `/dashboard/sync-records?companyId=${selectedCompanyId}&limit=${PAGE_SIZE}&offset=${offset}`,
            )
            setRecords(r.records)
            if (r.total !== undefined) setRecordTotal(r.total)
        } catch {
            /* ignore */
        }
    }

    async function handleRetryAllFailed() {
        setRetryAllLoading(true)
        try {
            await apiFetch('/dashboard/reprocess-exceptions', {
                method: 'POST',
                body: JSON.stringify({ companyId: selectedCompanyId, errorCode: 'ERPNEXT_WRITE_FAILED' }),
            })
            await refreshExceptions()
        } catch {
            /* ignore */
        }
        setRetryAllLoading(false)
    }

    // Poll stats every 3s to detect active sync
    useEffect(() => {
        if (!selectedCompanyId) return
        const t = setInterval(async () => {
            try {
                const s = await apiFetch<Stats>(`/dashboard/stats?companyId=${selectedCompanyId}`)
                setStats(s)
                const isActive = s.pending > 0 || s.synced !== prevSyncedRef.current
                if (isActive) {
                    setSyncProgress({ synced: s.synced, errored: s.errored, active: true })
                    if (syncProgressTimer.current) clearTimeout(syncProgressTimer.current)
                    syncProgressTimer.current = setTimeout(() => setSyncProgress(null), 10_000)
                }
                prevSyncedRef.current = s.synced
            } catch {
                /* ignore */
            }
        }, 3_000)
        return () => clearInterval(t)
    }, [selectedCompanyId])

    // Poll cloud health every 30s
    useEffect(() => {
        function check() {
            fetch('/health')
                .then((r) => r.json())
                .then((h: { db?: string; redis?: string }) => {
                    setCloudHealth({ db: h.db ?? 'unknown', redis: h.redis ?? 'unknown' })
                })
                .catch(() => setCloudHealth({ db: 'error', redis: 'error' }))
        }
        check()
        const t = setInterval(check, 30_000)
        return () => clearInterval(t)
    }, [])

    // Load companies on mount
    useEffect(() => {
        apiFetch<{ companies: Company[] }>('/dashboard/companies')
            .then((res) => {
                setCompanies(res.companies)
                if (res.companies.length > 0) {
                    // Prefer the most recently active company; fall back to first
                    const mostRecent = res.companies.reduce((a, b) => {
                        const ta = a.last_heartbeat_at ? new Date(a.last_heartbeat_at).getTime() : 0
                        const tb = b.last_heartbeat_at ? new Date(b.last_heartbeat_at).getTime() : 0
                        return tb > ta ? b : a
                    })
                    setSelectedCompanyId((prev) => prev || mostRecent.id)
                    const hb = mostRecent.last_heartbeat_at
                    if (hb) {
                        const ago = Date.now() - new Date(hb).getTime()
                        setConnectorOnline(ago < 60_000)
                    }
                }
            })
            .catch((err) => setError(err.message))
            .finally(() => setLoading(false))
    }, [])

    // Load stats + records + exceptions when company changes — reset pagination
    useEffect(() => {
        if (!selectedCompanyId) return
        setExceptionOffset(0)
        setRecordOffset(0)
        const qs = `?companyId=${selectedCompanyId}`
        Promise.all([
            apiFetch<Stats>(`/dashboard/stats${qs}`),
            apiFetch<{ records: SyncRecord[] }>(`/dashboard/sync-records${qs}&limit=${PAGE_SIZE}&offset=0`),
            apiFetch<{ exceptions: Exception[]; total: number }>(
                `/dashboard/exceptions${qs}&limit=${PAGE_SIZE}&offset=0`,
            ),
        ])
            .then(([s, r, e]) => {
                setStats(s)
                setRecords(r.records)
                setExceptions(e.exceptions)
                setExceptionTotal(e.total ?? 0)
            })
            .catch((err) => setError(err.message))
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [selectedCompanyId])

    // WebSocket for real-time updates
    const { lastMessage } = useWebSocket<WsMessage>({
        companyId: selectedCompanyId || 'none',
        reconnect: true,
    })

    useEffect(() => {
        if (!lastMessage) return
        if (lastMessage.event === 'connector:status') {
            setConnectorOnline(true)
            // Re-fetch companies so a newly connected company appears in the dropdown
            apiFetch<{ companies: Company[] }>('/dashboard/companies')
                .then((res) => {
                    setCompanies(res.companies)
                    // Auto-select the newly connected company (freshest heartbeat within last 60s)
                    const fresh = res.companies.find((c) => {
                        if (!c.last_heartbeat_at) return false
                        return Date.now() - new Date(c.last_heartbeat_at).getTime() < 60_000
                    })
                    if (fresh) {
                        setSelectedCompanyId(fresh.id)
                        setConnectorOnline(true)
                    }
                })
                .catch(() => {})
        }
        if (lastMessage.event === 'sync:progress' && selectedCompanyId) {
            apiFetch<Stats>(`/dashboard/stats?companyId=${selectedCompanyId}`)
                .then(setStats)
                .catch(() => {})
            // Refresh first page of records on sync progress
            apiFetch<{ records: SyncRecord[] }>(
                `/dashboard/sync-records?companyId=${selectedCompanyId}&limit=${PAGE_SIZE}&offset=0`,
            )
                .then((r) => {
                    setRecords(r.records)
                    setRecordOffset(0)
                })
                .catch(() => {})
        }
        if (lastMessage.event === 'exception:new' && selectedCompanyId) {
            apiFetch<{ exceptions: Exception[]; total: number }>(
                `/dashboard/exceptions?companyId=${selectedCompanyId}&limit=${PAGE_SIZE}&offset=0`,
            )
                .then((e) => {
                    setExceptions(e.exceptions)
                    setExceptionTotal(e.total ?? 0)
                    setExceptionOffset(0)
                })
                .catch(() => {})
        }
    }, [lastMessage, selectedCompanyId])

    // Load data comparison when tab is selected
    useEffect(() => {
        if (activeTab !== 'data' || !selectedCompanyId) return
        setDataLoading(true)
        apiFetch<DataComparison>(`/dashboard/data-comparison?companyId=${selectedCompanyId}`)
            .then(setDataComparison)
            .catch(() => {})
            .finally(() => setDataLoading(false))
    }, [activeTab, selectedCompanyId])

    if (loading)
        return <div className="min-h-screen flex items-center justify-center text-lg text-gray-500">Loading...</div>
    if (error)
        return <div className="min-h-screen flex items-center justify-center text-lg text-red-600">Error: {error}</div>

    // Show setup wizard when no companies are connected
    if (companies.length === 0) {
        return (
            <div className="min-h-screen bg-neutral-100 font-sans text-neutral-900">
                <nav className="bg-white border-b shadow-sm sticky top-0 z-10">
                    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
                        <div className="flex justify-between h-16">
                            <div className="flex items-center">
                                <span className="text-xl font-bold text-blue-600 tracking-tight">
                                    TallyBridge Cloud
                                </span>
                            </div>
                            <div className="flex items-center space-x-2 pl-2">
                                <span className="text-xs text-gray-500">{admin?.displayName || admin?.email}</span>
                                <button
                                    onClick={logout}
                                    className="text-xs text-gray-400 hover:text-red-600 transition-colors font-medium"
                                >
                                    Logout
                                </button>
                            </div>
                        </div>
                    </div>
                </nav>
                <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
                    <SetupWizard />
                </main>
            </div>
        )
    }

    const openExceptions = exceptions.filter((e) => !e.resolved_at)

    // Last config sync: use the selected company's heartbeat
    const selectedCompany = companies.find((c) => c.id === selectedCompanyId)
    const lastHeartbeat = selectedCompany?.last_heartbeat_at
    const lastHeartbeatDisplay = lastHeartbeat ? new Date(lastHeartbeat).toLocaleString() : 'No heartbeat received'

    return (
        <div className="min-h-screen bg-neutral-100 font-sans text-neutral-900">
            {/* Top Navbar */}
            <nav className="bg-white border-b shadow-sm sticky top-0 z-10">
                <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
                    <div className="flex justify-between h-16">
                        <div className="flex items-center space-x-8">
                            <span className="text-xl font-bold text-blue-600 tracking-tight">TallyBridge Cloud</span>
                            <div className="flex space-x-1">
                                {[
                                    { id: 'overview', label: 'Overview' },
                                    { id: 'data', label: 'Data Status' },
                                    {
                                        id: 'exceptions',
                                        label: `Exceptions (${stats?.openExceptions ?? openExceptions.length})`,
                                    },
                                    { id: 'activity', label: 'Activity Log' },
                                    { id: 'config', label: 'Configuration' },
                                    { id: 'settings', label: 'Settings' },
                                ].map((tab) => (
                                    <button
                                        key={tab.id}
                                        onClick={() => setActiveTab(tab.id)}
                                        className={`px-4 py-2 rounded-md transition-colors text-sm font-medium ${
                                            activeTab === tab.id
                                                ? 'bg-neutral-100 text-neutral-900 shadow-sm'
                                                : 'text-neutral-500 hover:text-neutral-700 hover:bg-neutral-50'
                                        }`}
                                    >
                                        {tab.label}
                                    </button>
                                ))}
                            </div>
                        </div>

                        <div className="flex items-center space-x-3">
                            {companies.length > 1 && (
                                <select
                                    value={selectedCompanyId}
                                    onChange={(e) => setSelectedCompanyId(e.target.value)}
                                    className="text-sm border rounded-md px-2 py-1"
                                >
                                    {companies.map((c) => (
                                        <option key={c.id} value={c.id}>
                                            {c.tally_company_name || c.erpnext_company}
                                        </option>
                                    ))}
                                </select>
                            )}

                            {/* Sync progress pill */}
                            {syncProgress && (
                                <div className="flex items-center space-x-2 text-sm px-3 py-1.5 rounded-full border bg-blue-50 border-blue-200 shadow-sm min-w-[160px]">
                                    <div className="w-2.5 h-2.5 rounded-full bg-blue-500 animate-pulse"></div>
                                    <div className="flex-1">
                                        <div className="flex justify-between text-xs font-medium text-blue-700 mb-0.5">
                                            <span>Syncing…</span>
                                            <span>{syncProgress.synced} synced</span>
                                        </div>
                                        <div className="w-full bg-blue-100 rounded-full h-1 overflow-hidden">
                                            <div
                                                className="bg-blue-500 h-1 rounded-full animate-pulse"
                                                style={{ width: '60%' }}
                                            />
                                        </div>
                                    </div>
                                    {syncProgress.errored > 0 && (
                                        <span className="text-xs font-semibold text-red-600">
                                            {syncProgress.errored} err
                                        </span>
                                    )}
                                </div>
                            )}

                            {/* Cloud service status */}
                            <div className="flex items-center space-x-1.5 text-xs px-2.5 py-1.5 rounded-full border shadow-sm bg-white">
                                <span className="text-gray-400 font-medium">Cloud</span>
                                <StatusDot ok={cloudHealth?.db === 'ok'} label="DB" />
                                <StatusDot ok={cloudHealth?.redis === 'ok'} label="Redis" />
                            </div>

                            {/* Connector status */}
                            <div
                                className={`flex items-center space-x-2 text-sm px-3 py-1.5 rounded-full border shadow-sm ${
                                    connectorOnline ? 'bg-green-50 border-green-200' : 'bg-red-50 border-red-200'
                                }`}
                            >
                                <div
                                    className={`w-2.5 h-2.5 rounded-full ${
                                        connectorOnline ? 'bg-green-500 animate-pulse' : 'bg-red-400'
                                    }`}
                                ></div>
                                <span
                                    className={`font-semibold ${connectorOnline ? 'text-green-700' : 'text-red-700'}`}
                                >
                                    {connectorOnline ? 'Connector Online' : 'Connector Offline'}
                                </span>
                            </div>

                            {/* Admin + Logout */}
                            <div className="flex items-center space-x-2 pl-2 border-l border-gray-200">
                                <span className="text-xs text-gray-500 hidden sm:inline">
                                    {admin?.displayName || admin?.email}
                                </span>
                                <button
                                    onClick={logout}
                                    className="text-xs text-gray-400 hover:text-red-600 transition-colors font-medium"
                                    title="Sign out"
                                >
                                    Logout
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            </nav>

            <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
                {/* -- OVERVIEW TAB -- */}
                {activeTab === 'overview' && (
                    <div className="space-y-6">
                        <div className="flex items-start justify-between">
                            <h1 className="text-2xl font-bold text-slate-800 tracking-tight">System Overview</h1>
                            {/* Task 4: Last config sync indicator */}
                            <div className="text-right">
                                <div className="text-xs text-gray-400 font-medium uppercase tracking-wide">
                                    Last Config Sync
                                </div>
                                <div className="text-sm text-gray-600 font-mono mt-0.5">{lastHeartbeatDisplay}</div>
                            </div>
                        </div>

                        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                            <MetricCard title="Vouchers Synced" value={stats?.synced ?? 0} />
                            <MetricCard title="Pending" value={stats?.pending ?? 0} />
                            <MetricCard
                                title="Exceptions"
                                value={stats?.openExceptions ?? 0}
                                type={stats?.openExceptions ? 'warning' : 'default'}
                            />
                            <MetricCard
                                title="Errors"
                                value={stats?.errored ?? 0}
                                type={stats?.errored ? 'danger' : 'default'}
                            />
                        </div>

                        <div className="bg-white rounded-xl shadow-sm border overflow-hidden">
                            <div className="px-6 py-4 border-b bg-gray-50 flex justify-between items-center">
                                <h3 className="font-semibold text-slate-800">Recent Sync Activity</h3>
                                <button
                                    onClick={() => setActiveTab('activity')}
                                    className="text-sm text-blue-600 font-medium hover:underline"
                                >
                                    View All
                                </button>
                            </div>
                            {records.length === 0 ? (
                                <div className="px-6 py-8 text-center text-gray-400">
                                    No sync records yet. Start a sync from the connector.
                                </div>
                            ) : (
                                <table className="min-w-full divide-y divide-gray-200">
                                    <thead className="bg-gray-50 text-xs uppercase font-semibold text-gray-500">
                                        <tr>
                                            <th className="px-6 py-3 text-left tracking-wider">Time</th>
                                            <th className="px-6 py-3 text-left tracking-wider">DocType</th>
                                            <th className="px-6 py-3 text-left tracking-wider">ERPNext Name</th>
                                            <th className="px-6 py-3 text-left tracking-wider">Status</th>
                                        </tr>
                                    </thead>
                                    <tbody className="bg-white divide-y divide-gray-200">
                                        {records.slice(0, 10).map((r, i) => (
                                            <tr key={i} className="hover:bg-gray-50 transition-colors">
                                                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                                                    {new Date(r.last_synced_at).toLocaleTimeString()}
                                                </td>
                                                <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">
                                                    {r.erpnext_doctype}
                                                </td>
                                                <td className="px-6 py-4 whitespace-nowrap text-sm text-blue-600 font-medium">
                                                    {r.erpnext_name || r.tally_guid.slice(0, 8)}
                                                </td>
                                                <td className="px-6 py-4 whitespace-nowrap">
                                                    <StatusBadge status={r.sync_status} />
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            )}
                        </div>
                    </div>
                )}

                {/* -- DATA STATUS TAB -- */}
                {activeTab === 'data' && (
                    <div className="space-y-6">
                        <h1 className="text-2xl font-bold text-slate-800 tracking-tight">
                            Data Status — Tally vs ERPNext
                        </h1>
                        <p className="text-slate-600">
                            Comparison of source counts from Tally, records synced in cloud, and documents created in
                            ERPNext.
                        </p>

                        {dataLoading ? (
                            <div className="bg-white rounded-xl shadow-sm border p-8 text-center text-gray-400">
                                Loading counts from ERPNext...
                            </div>
                        ) : dataComparison ? (
                            <>
                                {/* Task 3: Data Coverage summary cards */}
                                <div className="bg-white rounded-xl shadow-sm border p-5">
                                    <h3 className="font-semibold text-slate-800 mb-3">Data Coverage</h3>
                                    <div className="grid grid-cols-3 divide-x text-center">
                                        <div className="px-4">
                                            <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">
                                                Tally Source
                                            </div>
                                            <div className="text-3xl font-extrabold text-slate-800">
                                                {dataComparison.tallyCountsRaw
                                                    ? Object.values(dataComparison.tallyCountsRaw)
                                                          .reduce((a, b) => a + b, 0)
                                                          .toLocaleString()
                                                    : '—'}
                                            </div>
                                        </div>
                                        <div className="px-4">
                                            <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">
                                                Cloud Received
                                            </div>
                                            <div className="text-3xl font-extrabold text-blue-700">
                                                {dataComparison.totalTallySynced.toLocaleString()}
                                            </div>
                                        </div>
                                        <div className="px-4">
                                            <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">
                                                ERPNext Created
                                            </div>
                                            <div className="text-3xl font-extrabold text-green-700">
                                                {dataComparison.totalErpNext.toLocaleString()}
                                            </div>
                                        </div>
                                    </div>
                                </div>

                                {/* Summary stat cards */}
                                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                                    <MetricCard title="Total Synced (Cloud)" value={dataComparison.totalTallySynced} />
                                    <MetricCard title="Total in ERPNext" value={dataComparison.totalErpNext} />
                                    <MetricCard
                                        title="Open Exceptions"
                                        value={Object.values(dataComparison.exceptions).reduce((a, b) => a + b, 0)}
                                        type={
                                            Object.values(dataComparison.exceptions).reduce((a, b) => a + b, 0) > 0
                                                ? 'warning'
                                                : 'default'
                                        }
                                    />
                                </div>

                                {/* Task 3: Extended comparison table with Tally column */}
                                <div className="bg-white rounded-xl shadow-sm border overflow-hidden">
                                    <table className="min-w-full divide-y divide-gray-200">
                                        <thead className="bg-gray-50">
                                            <tr>
                                                <th className="px-6 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">
                                                    Type
                                                </th>
                                                <th className="px-6 py-3 text-right text-xs font-semibold text-gray-500 uppercase tracking-wider">
                                                    Tally
                                                </th>
                                                <th className="px-6 py-3 text-right text-xs font-semibold text-gray-500 uppercase tracking-wider">
                                                    Cloud
                                                </th>
                                                <th className="px-6 py-3 text-right text-xs font-semibold text-gray-500 uppercase tracking-wider">
                                                    ERPNext
                                                </th>
                                                <th className="px-6 py-3 text-right text-xs font-semibold text-gray-500 uppercase tracking-wider">
                                                    Gap
                                                </th>
                                                <th className="px-6 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">
                                                    Status
                                                </th>
                                            </tr>
                                        </thead>
                                        <tbody className="bg-white divide-y divide-gray-200">
                                            {dataComparison.comparison.map((row) => {
                                                const diff = row.tallySynced - row.erpnextCount
                                                const erpFailed = row.erpnextCount === -1
                                                const hasTallyCount =
                                                    dataComparison.tallyCountsRaw != null && row.tallyCount != null
                                                const tallyCount = row.tallyCount ?? null
                                                const gap =
                                                    hasTallyCount && tallyCount !== null
                                                        ? tallyCount - row.erpnextCount
                                                        : null
                                                return (
                                                    <tr
                                                        key={row.doctype}
                                                        className="hover:bg-gray-50 transition-colors"
                                                    >
                                                        <td className="px-6 py-4 text-sm font-medium text-gray-900">
                                                            {row.label}
                                                        </td>
                                                        <td className="px-6 py-4 text-sm text-right font-mono text-gray-700">
                                                            {hasTallyCount && tallyCount !== null ? (
                                                                tallyCount.toLocaleString()
                                                            ) : (
                                                                <span className="text-gray-300 text-xs">—</span>
                                                            )}
                                                        </td>
                                                        <td className="px-6 py-4 text-sm text-right font-mono text-gray-700">
                                                            {row.tallySynced.toLocaleString()}
                                                        </td>
                                                        <td className="px-6 py-4 text-sm text-right font-mono text-gray-700">
                                                            {erpFailed ? (
                                                                <span className="text-red-400">N/A</span>
                                                            ) : (
                                                                row.erpnextCount.toLocaleString()
                                                            )}
                                                        </td>
                                                        <td className="px-6 py-4 text-sm text-right font-mono">
                                                            {gap === null ? (
                                                                <span className="text-gray-300 text-xs">—</span>
                                                            ) : erpFailed ? (
                                                                '—'
                                                            ) : (
                                                                <span
                                                                    className={
                                                                        gap > 0
                                                                            ? 'text-red-600 font-semibold'
                                                                            : 'text-green-600 font-semibold'
                                                                    }
                                                                >
                                                                    {gap > 0 ? `+${gap}` : gap}
                                                                </span>
                                                            )}
                                                        </td>
                                                        <td className="px-6 py-4">
                                                            {erpFailed ? (
                                                                <span className="px-2.5 py-1 text-xs font-semibold rounded-full bg-gray-100 text-gray-500">
                                                                    Unavailable
                                                                </span>
                                                            ) : diff === 0 && row.tallySynced > 0 ? (
                                                                <span className="px-2.5 py-1 text-xs font-semibold rounded-full bg-green-100 text-green-800">
                                                                    In Sync
                                                                </span>
                                                            ) : diff > 0 ? (
                                                                <span className="px-2.5 py-1 text-xs font-semibold rounded-full bg-amber-100 text-amber-800">
                                                                    {diff} missing in ERPNext
                                                                </span>
                                                            ) : row.tallySynced === 0 && row.erpnextCount === 0 ? (
                                                                <span className="px-2.5 py-1 text-xs font-semibold rounded-full bg-gray-100 text-gray-500">
                                                                    No data
                                                                </span>
                                                            ) : (
                                                                <span className="px-2.5 py-1 text-xs font-semibold rounded-full bg-blue-100 text-blue-800">
                                                                    Extra in ERPNext
                                                                </span>
                                                            )}
                                                        </td>
                                                    </tr>
                                                )
                                            })}
                                        </tbody>
                                        <tfoot className="bg-gray-50 font-semibold text-sm">
                                            <tr>
                                                <td className="px-6 py-3 text-gray-700">Total</td>
                                                <td className="px-6 py-3 text-right font-mono text-gray-700">
                                                    {dataComparison.tallyCountsRaw
                                                        ? Object.values(dataComparison.tallyCountsRaw)
                                                              .reduce((a, b) => a + b, 0)
                                                              .toLocaleString()
                                                        : '—'}
                                                </td>
                                                <td className="px-6 py-3 text-right font-mono text-gray-700">
                                                    {dataComparison.totalTallySynced.toLocaleString()}
                                                </td>
                                                <td className="px-6 py-3 text-right font-mono text-gray-700">
                                                    {dataComparison.totalErpNext.toLocaleString()}
                                                </td>
                                                <td className="px-6 py-3 text-right font-mono">
                                                    {(() => {
                                                        const d =
                                                            dataComparison.totalTallySynced -
                                                            dataComparison.totalErpNext
                                                        return (
                                                            <span
                                                                className={d > 0 ? 'text-amber-600' : 'text-green-600'}
                                                            >
                                                                {d > 0 ? `+${d}` : d}
                                                            </span>
                                                        )
                                                    })()}
                                                </td>
                                                <td className="px-6 py-3"></td>
                                            </tr>
                                        </tfoot>
                                    </table>
                                    {/* Tally counts footer note */}
                                    <div className="px-6 py-3 border-t bg-gray-50">
                                        {dataComparison.tallyCountsRaw == null ? (
                                            <p className="text-xs text-gray-400 italic">
                                                Connect Tally to see source counts
                                            </p>
                                        ) : dataComparison.tallyCountsUpdatedAt ? (
                                            <p className="text-xs text-gray-400">
                                                Tally counts as of{' '}
                                                {new Date(dataComparison.tallyCountsUpdatedAt).toLocaleString()}
                                            </p>
                                        ) : null}
                                    </div>
                                </div>

                                {/* Exception breakdown */}
                                {Object.keys(dataComparison.exceptions).length > 0 && (
                                    <div className="bg-white rounded-xl shadow-sm border p-6">
                                        <h3 className="font-semibold text-slate-800 mb-4">Exception Breakdown</h3>
                                        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                                            {Object.entries(dataComparison.exceptions).map(([code, count]) => (
                                                <div
                                                    key={code}
                                                    className="bg-red-50 border border-red-100 rounded-lg p-4"
                                                >
                                                    <div className="text-2xl font-bold text-red-700">{count}</div>
                                                    <div className="text-xs text-red-600 font-mono mt-1">{code}</div>
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                )}

                                <button
                                    onClick={() => {
                                        setDataLoading(true)
                                        apiFetch<DataComparison>(
                                            `/dashboard/data-comparison?companyId=${selectedCompanyId}`,
                                        )
                                            .then(setDataComparison)
                                            .catch(() => {})
                                            .finally(() => setDataLoading(false))
                                    }}
                                    className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 transition-colors"
                                >
                                    Refresh Counts
                                </button>
                            </>
                        ) : (
                            <div className="bg-white rounded-xl shadow-sm border p-8 text-center text-gray-400">
                                Select a company to view data comparison.
                            </div>
                        )}
                    </div>
                )}

                {/* -- EXCEPTIONS TAB -- */}
                {activeTab === 'exceptions' && (
                    <div className="space-y-6">
                        <div className="flex items-center justify-between">
                            <h1 className="text-2xl font-bold text-slate-800 tracking-tight">Exception Register</h1>
                            {openExceptions.length > 0 && (
                                <button
                                    onClick={handleRetryAllFailed}
                                    disabled={retryAllLoading}
                                    className="px-4 py-2 text-sm font-medium bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors"
                                >
                                    {retryAllLoading ? 'Retrying...' : 'Retry All Failed'}
                                </button>
                            )}
                        </div>

                        {/* Group summary + reprocess buttons */}
                        {openExceptions.length > 0 &&
                            (() => {
                                const grouped: Record<string, number> = {}
                                for (const e of openExceptions) grouped[e.error_code] = (grouped[e.error_code] || 0) + 1
                                const RETRYABLE: Record<string, string> = {
                                    FALLBACK_TO_JOURNAL: 'Clears sync record so voucher re-syncs as Journal Entry',
                                    ERPNEXT_WRITE_FAILED:
                                        'Clears sync record so voucher is retried on next connector sync',
                                    MASTER_CREATE_FAILED: 'Clears sync record so master data creation is retried',
                                }
                                return (
                                    <div className="bg-white rounded-xl shadow-sm border p-5 space-y-3">
                                        <h2 className="text-sm font-semibold text-slate-700">By Error Code</h2>
                                        <div className="divide-y">
                                            {Object.entries(grouped).map(([code, count]) => (
                                                <div
                                                    key={code}
                                                    className="flex items-center justify-between py-3 gap-4"
                                                >
                                                    <div className="flex items-center gap-3">
                                                        <span className="font-mono text-sm font-bold text-red-700">
                                                            {code}
                                                        </span>
                                                        <span className="text-xs bg-red-50 text-red-600 border border-red-100 rounded px-2 py-0.5">
                                                            {count}
                                                        </span>
                                                        {RETRYABLE[code] && (
                                                            <span className="text-xs text-slate-400">
                                                                {RETRYABLE[code]}
                                                            </span>
                                                        )}
                                                    </div>
                                                    {RETRYABLE[code] && (
                                                        <button
                                                            disabled={reprocessing === code}
                                                            onClick={async () => {
                                                                if (
                                                                    !confirm(
                                                                        `Reprocess ${count} ${code} exceptions?\n\nSync records will be cleared so the connector re-sends these vouchers.`,
                                                                    )
                                                                )
                                                                    return
                                                                setReprocessing(code)
                                                                try {
                                                                    await apiFetch('/dashboard/reprocess-exceptions', {
                                                                        method: 'POST',
                                                                        body: JSON.stringify({
                                                                            companyId: selectedCompanyId,
                                                                            errorCode: code,
                                                                        }),
                                                                    })
                                                                    const [e] = await Promise.all([
                                                                        apiFetch<{ exceptions: Exception[] }>(
                                                                            `/dashboard/exceptions?companyId=${selectedCompanyId}`,
                                                                        ),
                                                                    ])
                                                                    setExceptions(e.exceptions)
                                                                } catch {
                                                                    /* ignore */
                                                                }
                                                                setReprocessing(null)
                                                            }}
                                                            className="text-xs px-3 py-1.5 rounded-lg border border-blue-200 text-blue-700 bg-blue-50 hover:bg-blue-100 disabled:opacity-50 font-medium"
                                                        >
                                                            {reprocessing === code ? 'Processing…' : 'Reprocess'}
                                                        </button>
                                                    )}
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                )
                            })()}

                        {openExceptions.length === 0 ? (
                            <div className="bg-white rounded-xl shadow-sm border p-8 text-center text-gray-400">
                                No open exceptions. All clear!
                            </div>
                        ) : (
                            <div className="space-y-3">
                                {openExceptions.map((exc) => (
                                    <ExceptionRow
                                        key={exc.id}
                                        exc={exc}
                                        companyId={selectedCompanyId}
                                        onResolved={refreshExceptions}
                                    />
                                ))}
                            </div>
                        )}

                        {/* Pagination */}
                        {exceptionTotal > PAGE_SIZE && (
                            <div className="flex items-center justify-between bg-white rounded-xl shadow-sm border px-5 py-3">
                                <span className="text-sm text-slate-500">
                                    Showing {exceptionOffset + 1}–
                                    {Math.min(exceptionOffset + PAGE_SIZE, exceptionTotal)} of {exceptionTotal}
                                </span>
                                <div className="flex gap-2">
                                    <button
                                        disabled={exceptionOffset === 0}
                                        onClick={() => {
                                            const o = Math.max(0, exceptionOffset - PAGE_SIZE)
                                            setExceptionOffset(o)
                                            refreshExceptions(o)
                                        }}
                                        className="px-3 py-1.5 text-sm rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50 disabled:opacity-40"
                                    >
                                        ← Prev
                                    </button>
                                    <button
                                        disabled={exceptionOffset + PAGE_SIZE >= exceptionTotal}
                                        onClick={() => {
                                            const o = exceptionOffset + PAGE_SIZE
                                            setExceptionOffset(o)
                                            refreshExceptions(o)
                                        }}
                                        className="px-3 py-1.5 text-sm rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50 disabled:opacity-40"
                                    >
                                        Next →
                                    </button>
                                </div>
                            </div>
                        )}
                    </div>
                )}

                {/* -- ACTIVITY LOG TAB -- */}
                {activeTab === 'activity' && (
                    <div className="space-y-6">
                        <h1 className="text-2xl font-bold text-slate-800 tracking-tight">Sync Activity Log</h1>
                        <div className="bg-white rounded-xl shadow-sm border overflow-hidden">
                            {records.length === 0 ? (
                                <div className="p-8 text-center text-gray-400">No sync records yet.</div>
                            ) : (
                                <table className="min-w-full divide-y divide-gray-200">
                                    <thead className="bg-gray-50 text-xs uppercase font-semibold text-gray-500">
                                        <tr>
                                            <th className="px-6 py-3 text-left">Time</th>
                                            <th className="px-6 py-3 text-left">Tally GUID</th>
                                            <th className="px-6 py-3 text-left">DocType</th>
                                            <th className="px-6 py-3 text-left">ERPNext Name</th>
                                            <th className="px-6 py-3 text-left">Status</th>
                                        </tr>
                                    </thead>
                                    <tbody className="bg-white divide-y divide-gray-200">
                                        {records.map((r, i) => (
                                            <tr key={i} className="hover:bg-gray-50">
                                                <td className="px-6 py-3 text-sm text-gray-500">
                                                    {new Date(r.last_synced_at).toLocaleString()}
                                                </td>
                                                <td className="px-6 py-3 text-sm font-mono text-gray-600">
                                                    {r.tally_guid.slice(0, 12)}...
                                                </td>
                                                <td className="px-6 py-3 text-sm">{r.erpnext_doctype}</td>
                                                <td className="px-6 py-3 text-sm text-blue-600 font-medium">
                                                    {r.erpnext_name}
                                                </td>
                                                <td className="px-6 py-3">
                                                    <StatusBadge status={r.sync_status} />
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            )}
                        </div>

                        {/* Pagination */}
                        {recordTotal > PAGE_SIZE && (
                            <div className="flex items-center justify-between bg-white rounded-xl shadow-sm border px-5 py-3">
                                <span className="text-sm text-slate-500">
                                    Showing {recordOffset + 1}–{Math.min(recordOffset + PAGE_SIZE, recordTotal)} of{' '}
                                    {recordTotal}
                                </span>
                                <div className="flex gap-2">
                                    <button
                                        disabled={recordOffset === 0}
                                        onClick={() => {
                                            const o = Math.max(0, recordOffset - PAGE_SIZE)
                                            setRecordOffset(o)
                                            refreshRecords(o)
                                        }}
                                        className="px-3 py-1.5 text-sm rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50 disabled:opacity-40"
                                    >
                                        ← Prev
                                    </button>
                                    <button
                                        disabled={recordOffset + PAGE_SIZE >= recordTotal}
                                        onClick={() => {
                                            const o = recordOffset + PAGE_SIZE
                                            setRecordOffset(o)
                                            refreshRecords(o)
                                        }}
                                        className="px-3 py-1.5 text-sm rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50 disabled:opacity-40"
                                    >
                                        Next →
                                    </button>
                                </div>
                            </div>
                        )}
                    </div>
                )}

                {/* -- CONFIGURATION TAB (Task 1) -- */}
                {activeTab === 'config' && (
                    <div className="space-y-6">
                        <h1 className="text-2xl font-bold text-slate-800 tracking-tight">Configuration</h1>
                        <p className="text-slate-600">
                            Manage account mappings, GST ledgers, voucher type mappings, and warehouse mappings for{' '}
                            <strong>{selectedCompany?.tally_company_name}</strong>.
                        </p>
                        {selectedCompanyId ? (
                            <ConfigurationTab companyId={selectedCompanyId} />
                        ) : (
                            <div className="bg-white rounded-xl shadow-sm border p-8 text-center text-gray-400">
                                Select a company to configure.
                            </div>
                        )}
                    </div>
                )}

                {/* -- SETTINGS TAB -- */}
                {activeTab === 'settings' && (
                    <div className="space-y-6">
                        <h1 className="text-2xl font-bold text-slate-800 tracking-tight">Settings</h1>

                        {/* Account Info */}
                        <div className="bg-white rounded-xl shadow-sm border p-6">
                            <h3 className="font-semibold text-lg mb-4">Account</h3>
                            <div className="flex items-center gap-4">
                                <div className="w-12 h-12 rounded-full bg-blue-100 flex items-center justify-center text-blue-700 font-bold text-lg">
                                    {(admin?.displayName || admin?.email || '?')[0].toUpperCase()}
                                </div>
                                <div>
                                    <div className="font-medium text-gray-900">
                                        {admin?.displayName || 'Admin User'}
                                    </div>
                                    <div className="text-sm text-gray-500">{admin?.email}</div>
                                    <span
                                        className={`inline-block mt-1 text-xs font-medium px-2 py-0.5 rounded-full ${
                                            admin?.role === 'superadmin'
                                                ? 'bg-purple-100 text-purple-700'
                                                : 'bg-blue-100 text-blue-700'
                                        }`}
                                    >
                                        {admin?.role === 'superadmin' ? 'Super Admin' : 'Company Admin'}
                                    </span>
                                </div>
                            </div>
                        </div>

                        {/* Admin Management — superadmin only */}
                        {admin?.role === 'superadmin' && <AdminManager companies={companies} />}

                        <div className="bg-white rounded-xl shadow-sm border p-6 space-y-4">
                            <h3 className="font-semibold text-lg">Registered Companies</h3>
                            {companies.map((c) => (
                                <div
                                    key={c.id}
                                    className="flex items-center justify-between p-4 bg-gray-50 rounded-lg border"
                                >
                                    <div>
                                        <div className="font-medium">{c.tally_company_name}</div>
                                        <div className="text-sm text-gray-500">
                                            ERPNext: {c.erpnext_company || 'Not configured'}
                                        </div>
                                        <div className="text-xs text-gray-400 font-mono">ID: {c.id}</div>
                                    </div>
                                    <div className="text-right">
                                        <div className="text-sm text-gray-500">
                                            {c.last_heartbeat_at
                                                ? `Last heartbeat: ${new Date(c.last_heartbeat_at).toLocaleString()}`
                                                : 'No heartbeat received'}
                                        </div>
                                        {c.last_heartbeat_at && (
                                            <div className="text-xs text-gray-400 mt-0.5">
                                                Last config sync: {new Date(c.last_heartbeat_at).toLocaleString()}
                                            </div>
                                        )}
                                    </div>
                                </div>
                            ))}
                        </div>

                        {/* Opening Stock Sync */}
                        <div className="bg-white rounded-xl shadow-sm border p-6 space-y-4">
                            <div>
                                <h3 className="font-semibold text-lg">Opening Stock Sync</h3>
                                <p className="text-sm text-gray-500 mt-1">
                                    Creates a Stock Reconciliation in ERPNext from Tally opening balances stored in
                                    master data. Run this <strong>once</strong> before the first sync so invoices can
                                    deduct stock correctly. Requires master data (stock items) to be synced first via
                                    the connector.
                                </p>
                            </div>
                            <div className="flex items-end gap-3">
                                <div>
                                    <label className="block text-xs font-medium text-gray-600 mb-1">
                                        Posting Date (FY start)
                                    </label>
                                    <input
                                        type="date"
                                        value={openingStockDate}
                                        onChange={(e) => setOpeningStockDate(e.target.value)}
                                        disabled={openingStockLoading}
                                        className="border rounded-md px-3 py-1.5 text-sm font-mono"
                                    />
                                </div>
                                <button
                                    disabled={openingStockLoading || !selectedCompanyId}
                                    onClick={async () => {
                                        setOpeningStockLoading(true)
                                        setOpeningStockResult(null)
                                        try {
                                            const res = await apiFetch<{
                                                ok: boolean
                                                itemCount?: number
                                                warehouse?: string
                                                error?: string
                                            }>('/dashboard/opening-stock', {
                                                method: 'POST',
                                                body: JSON.stringify({
                                                    companyId: selectedCompanyId,
                                                    postingDate: openingStockDate,
                                                }),
                                            })
                                            if (res.ok) {
                                                setOpeningStockResult({
                                                    ok: true,
                                                    message: `Created Stock Reconciliation with ${res.itemCount} items in ${res.warehouse}`,
                                                })
                                            } else {
                                                setOpeningStockResult({
                                                    ok: false,
                                                    message: res.error ?? 'Unknown error',
                                                })
                                            }
                                        } catch (e) {
                                            setOpeningStockResult({ ok: false, message: String(e) })
                                        }
                                        setOpeningStockLoading(false)
                                    }}
                                    className="px-4 py-2 rounded-md text-sm font-semibold bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                                >
                                    {openingStockLoading ? 'Syncing…' : 'Sync Opening Stock'}
                                </button>
                            </div>
                            {openingStockResult && (
                                <div
                                    className={`text-sm px-4 py-2 rounded-lg border ${openingStockResult.ok ? 'bg-green-50 border-green-200 text-green-800' : 'bg-red-50 border-red-200 text-red-700'}`}
                                >
                                    {openingStockResult.message}
                                </div>
                            )}
                        </div>

                        {/* Danger Zone */}
                        <div className="bg-white rounded-xl shadow-sm border border-red-100 p-6 space-y-4">
                            <h3 className="font-semibold text-lg text-red-700">Danger Zone</h3>
                            <p className="text-sm text-gray-500">
                                Clears sync records and exceptions for the selected company. Account mappings and config
                                are <strong>preserved</strong>. Reset connector watermarks separately before re-syncing.
                            </p>
                            <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer select-none">
                                <input
                                    type="checkbox"
                                    checked={resetIncludeMasters}
                                    onChange={(e) => setResetIncludeMasters(e.target.checked)}
                                    className="rounded"
                                />
                                Also clear master data (stock items &amp; ledgers) — required if you re-sync from
                                scratch
                            </label>
                            <button
                                onClick={handleResetSync}
                                disabled={resetting || !selectedCompanyId}
                                className="px-4 py-2 rounded-md text-sm font-semibold bg-red-600 text-white hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                            >
                                {resetting ? 'Resetting…' : 'Reset Sync History'}
                            </button>
                        </div>
                    </div>
                )}
            </main>
        </div>
    )
}

function StatusDot({ ok, label }: { ok: boolean | undefined; label: string }) {
    return (
        <span className="flex items-center space-x-1">
            <span
                className={`w-2 h-2 rounded-full ${ok === undefined ? 'bg-gray-300' : ok ? 'bg-green-500' : 'bg-red-500'}`}
            />
            <span
                className={`font-medium ${ok === undefined ? 'text-gray-400' : ok ? 'text-green-700' : 'text-red-600'}`}
            >
                {label}
            </span>
        </span>
    )
}

function MetricCard({ title, value, type = 'default' }: { title: string; value: number | string; type?: string }) {
    const colors: Record<string, string> = {
        default: 'text-slate-900',
        warning: 'text-amber-600',
        danger: 'text-red-600',
    }
    return (
        <div className="bg-white p-6 rounded-xl shadow-sm border border-slate-100 flex flex-col justify-between hover:shadow-md transition-shadow">
            <h3 className="text-sm font-semibold text-slate-500 uppercase tracking-wider mb-2">{title}</h3>
            <span className={`text-4xl font-extrabold tracking-tight ${colors[type] || colors.default}`}>{value}</span>
        </div>
    )
}

function StatusBadge({ status }: { status: string }) {
    const styles: Record<string, string> = {
        SYNCED: 'bg-green-100 text-green-800',
        PENDING: 'bg-yellow-100 text-yellow-800',
        ERROR: 'bg-red-100 text-red-800',
        CONFLICT: 'bg-orange-100 text-orange-800',
    }
    return (
        <span
            className={`px-2.5 py-1 inline-flex text-xs leading-5 font-semibold rounded-full ${styles[status] || 'bg-gray-100 text-gray-800'}`}
        >
            {status}
        </span>
    )
}
