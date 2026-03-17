import { useState, useEffect, useRef } from 'react'
import { apiFetch } from '../../lib/api'
import { useWebSocket } from '../../lib/useWebSocket'

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
}

interface DataComparison {
    comparison: DataRow[]
    exceptions: Record<string, number>
    totalTallySynced: number
    totalErpNext: number
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

export default function CloudDashboard() {
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
    const prevSyncedRef = useRef<number>(-1)
    const syncProgressTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

    async function handleResetSync() {
        const mastersWarning = resetIncludeMasters ? '\n\nWARNING: Master data (stock items, ledgers) will also be cleared.\nYou must re-sync the connector before using Sync Opening Stock.' : ''
        if (!confirm(`This will delete all sync records and exceptions for this company.\nAccount mappings and config are preserved.${mastersWarning}\n\nContinue?`)) return
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
                apiFetch<Stats>(`/dashboard/stats?companyId=${selectedCompanyId}`).then(setStats).catch(() => {})
            }
        } finally {
            setResetting(false)
        }
    }

    // Poll stats every 3s to detect active sync — drives the progress indicator
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
            } catch { /* ignore */ }
        }, 3_000)
        return () => clearInterval(t)
    }, [selectedCompanyId])

    // Poll cloud health every 30s
    useEffect(() => {
        function check() {
            fetch('/health').then(r => r.json()).then((h: { db?: string; redis?: string }) => {
                setCloudHealth({ db: h.db ?? 'unknown', redis: h.redis ?? 'unknown' })
            }).catch(() => setCloudHealth({ db: 'error', redis: 'error' }))
        }
        check()
        const t = setInterval(check, 30_000)
        return () => clearInterval(t)
    }, [])

    // Load companies on mount
    useEffect(() => {
        apiFetch<{ companies: Company[] }>('/dashboard/companies')
            .then(res => {
                setCompanies(res.companies)
                if (res.companies.length > 0) {
                    setSelectedCompanyId(res.companies[0].id)
                    const hb = res.companies[0].last_heartbeat_at
                    if (hb) {
                        const ago = Date.now() - new Date(hb).getTime()
                        setConnectorOnline(ago < 60_000)
                    }
                }
            })
            .catch(err => setError(err.message))
            .finally(() => setLoading(false))
    }, [])

    // Load stats + records + exceptions when company changes
    useEffect(() => {
        if (!selectedCompanyId) return
        const qs = `?companyId=${selectedCompanyId}`
        Promise.all([
            apiFetch<Stats>(`/dashboard/stats${qs}`),
            apiFetch<{ records: SyncRecord[] }>(`/dashboard/sync-records${qs}&limit=20`),
            apiFetch<{ exceptions: Exception[] }>(`/dashboard/exceptions${qs}`),
        ]).then(([s, r, e]) => {
            setStats(s)
            setRecords(r.records)
            setExceptions(e.exceptions)
        }).catch(err => setError(err.message))
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
        }
        if (lastMessage.event === 'sync:progress' && selectedCompanyId) {
            apiFetch<Stats>(`/dashboard/stats?companyId=${selectedCompanyId}`)
                .then(setStats).catch(() => {})
            apiFetch<{ records: SyncRecord[] }>(`/dashboard/sync-records?companyId=${selectedCompanyId}&limit=20`)
                .then(r => setRecords(r.records)).catch(() => {})
        }
        if (lastMessage.event === 'exception:new' && selectedCompanyId) {
            apiFetch<{ exceptions: Exception[] }>(`/dashboard/exceptions?companyId=${selectedCompanyId}`)
                .then(e => setExceptions(e.exceptions)).catch(() => {})
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

    if (loading) return <div className="min-h-screen flex items-center justify-center text-lg text-gray-500">Loading...</div>
    if (error) return <div className="min-h-screen flex items-center justify-center text-lg text-red-600">Error: {error}</div>

    const openExceptions = exceptions.filter(e => !e.resolved_at)

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
                                    { id: 'exceptions', label: `Exceptions (${stats?.openExceptions ?? openExceptions.length})` },
                                    { id: 'activity', label: 'Activity Log' },
                                    { id: 'settings', label: 'Settings' },
                                ].map(tab => (
                                    <button
                                        key={tab.id}
                                        onClick={() => setActiveTab(tab.id)}
                                        className={`px-4 py-2 rounded-md transition-colors text-sm font-medium ${activeTab === tab.id
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
                                    onChange={e => setSelectedCompanyId(e.target.value)}
                                    className="text-sm border rounded-md px-2 py-1"
                                >
                                    {companies.map(c => (
                                        <option key={c.id} value={c.id}>{c.tally_company_name || c.erpnext_company}</option>
                                    ))}
                                </select>
                            )}

                            {/* Sync progress pill — only shown during active sync */}
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
                                        <span className="text-xs font-semibold text-red-600">{syncProgress.errored} err</span>
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
                            <div className={`flex items-center space-x-2 text-sm px-3 py-1.5 rounded-full border shadow-sm ${
                                connectorOnline ? 'bg-green-50 border-green-200' : 'bg-red-50 border-red-200'
                            }`}>
                                <div className={`w-2.5 h-2.5 rounded-full ${
                                    connectorOnline ? 'bg-green-500 animate-pulse' : 'bg-red-400'
                                }`}></div>
                                <span className={`font-semibold ${connectorOnline ? 'text-green-700' : 'text-red-700'}`}>
                                    {connectorOnline ? 'Connector Online' : 'Connector Offline'}
                                </span>
                            </div>
                        </div>
                    </div>
                </div>
            </nav>

            <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">

                {/* -- OVERVIEW TAB -- */}
                {activeTab === 'overview' && (
                    <div className="space-y-6">
                        <h1 className="text-2xl font-bold text-slate-800 tracking-tight">System Overview</h1>

                        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                            <MetricCard title="Vouchers Synced" value={stats?.synced ?? 0} />
                            <MetricCard title="Pending" value={stats?.pending ?? 0} />
                            <MetricCard title="Exceptions" value={stats?.openExceptions ?? 0} type={stats?.openExceptions ? 'warning' : 'default'} />
                            <MetricCard title="Errors" value={stats?.errored ?? 0} type={stats?.errored ? 'danger' : 'default'} />
                        </div>

                        <div className="bg-white rounded-xl shadow-sm border overflow-hidden">
                            <div className="px-6 py-4 border-b bg-gray-50 flex justify-between items-center">
                                <h3 className="font-semibold text-slate-800">Recent Sync Activity</h3>
                                <button onClick={() => setActiveTab('activity')} className="text-sm text-blue-600 font-medium hover:underline">View All</button>
                            </div>
                            {records.length === 0 ? (
                                <div className="px-6 py-8 text-center text-gray-400">No sync records yet. Start a sync from the connector.</div>
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
                        <h1 className="text-2xl font-bold text-slate-800 tracking-tight">Data Status — Tally vs ERPNext</h1>
                        <p className="text-slate-600">Comparison of synced records in the cloud database vs documents created in ERPNext.</p>

                        {dataLoading ? (
                            <div className="bg-white rounded-xl shadow-sm border p-8 text-center text-gray-400">Loading counts from ERPNext...</div>
                        ) : dataComparison ? (
                            <>
                                {/* Summary cards */}
                                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                                    <MetricCard title="Total Synced (Cloud)" value={dataComparison.totalTallySynced} />
                                    <MetricCard title="Total in ERPNext" value={dataComparison.totalErpNext} />
                                    <MetricCard
                                        title="Open Exceptions"
                                        value={Object.values(dataComparison.exceptions).reduce((a, b) => a + b, 0)}
                                        type={Object.values(dataComparison.exceptions).reduce((a, b) => a + b, 0) > 0 ? 'warning' : 'default'}
                                    />
                                </div>

                                {/* Comparison table */}
                                <div className="bg-white rounded-xl shadow-sm border overflow-hidden">
                                    <table className="min-w-full divide-y divide-gray-200">
                                        <thead className="bg-gray-50">
                                            <tr>
                                                <th className="px-6 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Document Type</th>
                                                <th className="px-6 py-3 text-right text-xs font-semibold text-gray-500 uppercase tracking-wider">Cloud (Synced)</th>
                                                <th className="px-6 py-3 text-right text-xs font-semibold text-gray-500 uppercase tracking-wider">ERPNext</th>
                                                <th className="px-6 py-3 text-right text-xs font-semibold text-gray-500 uppercase tracking-wider">Diff</th>
                                                <th className="px-6 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Status</th>
                                            </tr>
                                        </thead>
                                        <tbody className="bg-white divide-y divide-gray-200">
                                            {dataComparison.comparison.map((row) => {
                                                const diff = row.tallySynced - row.erpnextCount
                                                const erpFailed = row.erpnextCount === -1
                                                return (
                                                    <tr key={row.doctype} className="hover:bg-gray-50 transition-colors">
                                                        <td className="px-6 py-4 text-sm font-medium text-gray-900">{row.label}</td>
                                                        <td className="px-6 py-4 text-sm text-right font-mono text-gray-700">{row.tallySynced.toLocaleString()}</td>
                                                        <td className="px-6 py-4 text-sm text-right font-mono text-gray-700">
                                                            {erpFailed ? <span className="text-red-400">N/A</span> : row.erpnextCount.toLocaleString()}
                                                        </td>
                                                        <td className="px-6 py-4 text-sm text-right font-mono">
                                                            {erpFailed ? '—' : (
                                                                <span className={diff > 0 ? 'text-amber-600 font-semibold' : diff === 0 ? 'text-green-600' : 'text-blue-600'}>
                                                                    {diff > 0 ? `+${diff}` : diff === 0 ? '0' : diff}
                                                                </span>
                                                            )}
                                                        </td>
                                                        <td className="px-6 py-4">
                                                            {erpFailed ? (
                                                                <span className="px-2.5 py-1 text-xs font-semibold rounded-full bg-gray-100 text-gray-500">Unavailable</span>
                                                            ) : diff === 0 && row.tallySynced > 0 ? (
                                                                <span className="px-2.5 py-1 text-xs font-semibold rounded-full bg-green-100 text-green-800">In Sync</span>
                                                            ) : diff > 0 ? (
                                                                <span className="px-2.5 py-1 text-xs font-semibold rounded-full bg-amber-100 text-amber-800">{diff} missing in ERPNext</span>
                                                            ) : row.tallySynced === 0 && row.erpnextCount === 0 ? (
                                                                <span className="px-2.5 py-1 text-xs font-semibold rounded-full bg-gray-100 text-gray-500">No data</span>
                                                            ) : (
                                                                <span className="px-2.5 py-1 text-xs font-semibold rounded-full bg-blue-100 text-blue-800">Extra in ERPNext</span>
                                                            )}
                                                        </td>
                                                    </tr>
                                                )
                                            })}
                                        </tbody>
                                        <tfoot className="bg-gray-50 font-semibold text-sm">
                                            <tr>
                                                <td className="px-6 py-3 text-gray-700">Total</td>
                                                <td className="px-6 py-3 text-right font-mono text-gray-700">{dataComparison.totalTallySynced.toLocaleString()}</td>
                                                <td className="px-6 py-3 text-right font-mono text-gray-700">{dataComparison.totalErpNext.toLocaleString()}</td>
                                                <td className="px-6 py-3 text-right font-mono">
                                                    {(() => {
                                                        const d = dataComparison.totalTallySynced - dataComparison.totalErpNext
                                                        return <span className={d > 0 ? 'text-amber-600' : 'text-green-600'}>{d > 0 ? `+${d}` : d}</span>
                                                    })()}
                                                </td>
                                                <td className="px-6 py-3"></td>
                                            </tr>
                                        </tfoot>
                                    </table>
                                </div>

                                {/* Exception breakdown */}
                                {Object.keys(dataComparison.exceptions).length > 0 && (
                                    <div className="bg-white rounded-xl shadow-sm border p-6">
                                        <h3 className="font-semibold text-slate-800 mb-4">Exception Breakdown</h3>
                                        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                                            {Object.entries(dataComparison.exceptions).map(([code, count]) => (
                                                <div key={code} className="bg-red-50 border border-red-100 rounded-lg p-4">
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
                                        apiFetch<DataComparison>(`/dashboard/data-comparison?companyId=${selectedCompanyId}`)
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
                        <h1 className="text-2xl font-bold text-slate-800 tracking-tight">Exception Register</h1>

                        {/* Group summary + reprocess buttons */}
                        {openExceptions.length > 0 && (() => {
                            const grouped: Record<string, number> = {}
                            for (const e of openExceptions) grouped[e.error_code] = (grouped[e.error_code] || 0) + 1
                            const RETRYABLE: Record<string, string> = {
                                'FALLBACK_TO_JOURNAL': 'Clears sync record so voucher re-syncs as Journal Entry',
                                'ERPNEXT_WRITE_FAILED': 'Clears sync record so voucher is retried on next connector sync',
                                'MASTER_CREATE_FAILED': 'Clears sync record so master data creation is retried',
                            }
                            return (
                                <div className="bg-white rounded-xl shadow-sm border p-5 space-y-3">
                                    <h2 className="text-sm font-semibold text-slate-700">By Error Code</h2>
                                    <div className="divide-y">
                                        {Object.entries(grouped).map(([code, count]) => (
                                            <div key={code} className="flex items-center justify-between py-3 gap-4">
                                                <div className="flex items-center gap-3">
                                                    <span className="font-mono text-sm font-bold text-red-700">{code}</span>
                                                    <span className="text-xs bg-red-50 text-red-600 border border-red-100 rounded px-2 py-0.5">{count}</span>
                                                    {RETRYABLE[code] && <span className="text-xs text-slate-400">{RETRYABLE[code]}</span>}
                                                </div>
                                                {RETRYABLE[code] && (
                                                    <button
                                                        disabled={reprocessing === code}
                                                        onClick={async () => {
                                                            if (!confirm(`Reprocess ${count} ${code} exceptions?\n\nSync records will be cleared so the connector re-sends these vouchers.`)) return
                                                            setReprocessing(code)
                                                            try {
                                                                await apiFetch('/dashboard/reprocess-exceptions', {
                                                                    method: 'POST',
                                                                    body: JSON.stringify({ companyId: selectedCompanyId, errorCode: code }),
                                                                })
                                                                const [e] = await Promise.all([
                                                                    apiFetch<{ exceptions: Exception[] }>(`/dashboard/exceptions?companyId=${selectedCompanyId}`),
                                                                ])
                                                                setExceptions(e.exceptions)
                                                            } catch { /* ignore */ }
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
                                {openExceptions.map(exc => (
                                    <div key={exc.id} className="bg-white rounded-xl shadow-sm border border-red-100 p-4">
                                        <div className="space-y-2">
                                            <div className="flex items-center space-x-3">
                                                <span className="px-2 py-0.5 text-xs font-bold bg-red-100 text-red-800 rounded border border-red-200">
                                                    {exc.tier}
                                                </span>
                                                <span className="text-xs font-mono text-slate-600">{exc.document_ref}</span>
                                                <span className="text-xs text-gray-400">{new Date(exc.created_at).toLocaleString()}</span>
                                            </div>
                                            <div className="text-sm text-slate-700 bg-slate-50 p-2.5 rounded-lg border">
                                                <span className="font-mono text-red-600 mr-2 font-bold">{exc.error_code}</span>
                                                {exc.error_message}
                                            </div>
                                        </div>
                                    </div>
                                ))}
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
                                                <td className="px-6 py-3 text-sm text-gray-500">{new Date(r.last_synced_at).toLocaleString()}</td>
                                                <td className="px-6 py-3 text-sm font-mono text-gray-600">{r.tally_guid.slice(0, 12)}...</td>
                                                <td className="px-6 py-3 text-sm">{r.erpnext_doctype}</td>
                                                <td className="px-6 py-3 text-sm text-blue-600 font-medium">{r.erpnext_name}</td>
                                                <td className="px-6 py-3"><StatusBadge status={r.sync_status} /></td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            )}
                        </div>
                    </div>
                )}

                {/* -- SETTINGS TAB -- */}
                {activeTab === 'settings' && (
                    <div className="space-y-6">
                        <h1 className="text-2xl font-bold text-slate-800 tracking-tight">Settings</h1>
                        <div className="bg-white rounded-xl shadow-sm border p-6 space-y-4">
                            <h3 className="font-semibold text-lg">Registered Companies</h3>
                            {companies.map(c => (
                                <div key={c.id} className="flex items-center justify-between p-4 bg-gray-50 rounded-lg border">
                                    <div>
                                        <div className="font-medium">{c.tally_company_name}</div>
                                        <div className="text-sm text-gray-500">ERPNext: {c.erpnext_company || 'Not configured'}</div>
                                        <div className="text-xs text-gray-400 font-mono">ID: {c.id}</div>
                                    </div>
                                    <div className="text-sm text-gray-500">
                                        {c.last_heartbeat_at
                                            ? `Last heartbeat: ${new Date(c.last_heartbeat_at).toLocaleString()}`
                                            : 'No heartbeat received'}
                                    </div>
                                </div>
                            ))}
                        </div>

                        {/* Opening Stock Sync */}
                        <div className="bg-white rounded-xl shadow-sm border p-6 space-y-4">
                            <div>
                                <h3 className="font-semibold text-lg">Opening Stock Sync</h3>
                                <p className="text-sm text-gray-500 mt-1">
                                    Creates a Stock Reconciliation in ERPNext from Tally opening balances stored in master data.
                                    Run this <strong>once</strong> before the first sync so invoices can deduct stock correctly.
                                    Requires master data (stock items) to be synced first via the connector.
                                </p>
                            </div>
                            <div className="flex items-end gap-3">
                                <div>
                                    <label className="block text-xs font-medium text-gray-600 mb-1">Posting Date (FY start)</label>
                                    <input
                                        type="date"
                                        value={openingStockDate}
                                        onChange={e => setOpeningStockDate(e.target.value)}
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
                                            const res = await apiFetch<{ ok: boolean; itemCount?: number; warehouse?: string; error?: string }>(
                                                '/dashboard/opening-stock',
                                                {
                                                    method: 'POST',
                                                    body: JSON.stringify({ companyId: selectedCompanyId, postingDate: openingStockDate }),
                                                }
                                            )
                                            if (res.ok) {
                                                setOpeningStockResult({ ok: true, message: `Created Stock Reconciliation with ${res.itemCount} items in ${res.warehouse}` })
                                            } else {
                                                setOpeningStockResult({ ok: false, message: res.error ?? 'Unknown error' })
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
                                <div className={`text-sm px-4 py-2 rounded-lg border ${openingStockResult.ok ? 'bg-green-50 border-green-200 text-green-800' : 'bg-red-50 border-red-200 text-red-700'}`}>
                                    {openingStockResult.message}
                                </div>
                            )}
                        </div>

                        {/* Danger Zone */}
                        <div className="bg-white rounded-xl shadow-sm border border-red-100 p-6 space-y-4">
                            <h3 className="font-semibold text-lg text-red-700">Danger Zone</h3>
                            <p className="text-sm text-gray-500">
                                Clears sync records and exceptions for the selected company.
                                Account mappings and config are <strong>preserved</strong>.
                                Reset connector watermarks separately before re-syncing.
                            </p>
                            <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer select-none">
                                <input
                                    type="checkbox"
                                    checked={resetIncludeMasters}
                                    onChange={e => setResetIncludeMasters(e.target.checked)}
                                    className="rounded"
                                />
                                Also clear master data (stock items &amp; ledgers) — required if you re-sync from scratch
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
            <span className={`w-2 h-2 rounded-full ${ok === undefined ? 'bg-gray-300' : ok ? 'bg-green-500' : 'bg-red-500'}`} />
            <span className={`font-medium ${ok === undefined ? 'text-gray-400' : ok ? 'text-green-700' : 'text-red-600'}`}>{label}</span>
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
        <span className={`px-2.5 py-1 inline-flex text-xs leading-5 font-semibold rounded-full ${styles[status] || 'bg-gray-100 text-gray-800'}`}>
            {status}
        </span>
    )
}
