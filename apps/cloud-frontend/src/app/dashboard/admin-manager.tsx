import { useState, useEffect } from 'react'
import { apiFetch } from '../../lib/api'

interface AdminUser {
    id: string
    email: string
    display_name: string | null
    role: string
    is_active: boolean
    last_login_at: string | null
    created_at: string
    companies: { id: string; name: string }[]
}

interface Company {
    id: string
    tally_company_name: string
}

export default function AdminManager({ companies }: { companies: Company[] }) {
    const [admins, setAdmins] = useState<AdminUser[]>([])
    const [loading, setLoading] = useState(true)
    const [showForm, setShowForm] = useState(false)
    const [editingId, setEditingId] = useState<string | null>(null)
    const [formError, setFormError] = useState('')
    const [saving, setSaving] = useState(false)

    // Form fields
    const [formEmail, setFormEmail] = useState('')
    const [formPassword, setFormPassword] = useState('')
    const [formName, setFormName] = useState('')
    const [formRole, setFormRole] = useState('company_admin')
    const [formCompanyIds, setFormCompanyIds] = useState<string[]>([])

    useEffect(() => {
        loadAdmins()
    }, [])

    async function loadAdmins() {
        try {
            const res = await apiFetch<{ admins: AdminUser[] }>('/dashboard/admins')
            setAdmins(res.admins)
        } catch {
            /* ignore */
        }
        setLoading(false)
    }

    function resetForm() {
        setFormEmail('')
        setFormPassword('')
        setFormName('')
        setFormRole('company_admin')
        setFormCompanyIds([])
        setFormError('')
        setEditingId(null)
        setShowForm(false)
    }

    function startEdit(a: AdminUser) {
        setEditingId(a.id)
        setFormEmail(a.email)
        setFormPassword('')
        setFormName(a.display_name ?? '')
        setFormRole(a.role)
        setFormCompanyIds(a.companies.map((c) => c.id))
        setFormError('')
        setShowForm(true)
    }

    async function handleSave() {
        setFormError('')
        setSaving(true)
        try {
            if (editingId) {
                // Update
                await apiFetch(`/dashboard/admins/${editingId}`, {
                    method: 'PUT',
                    body: JSON.stringify({
                        displayName: formName || undefined,
                        role: formRole,
                        password: formPassword || undefined,
                        companyIds: formCompanyIds,
                    }),
                })
            } else {
                // Create
                if (!formEmail || !formPassword) {
                    setFormError('Email and password are required')
                    setSaving(false)
                    return
                }
                await apiFetch('/dashboard/admins', {
                    method: 'POST',
                    body: JSON.stringify({
                        email: formEmail,
                        password: formPassword,
                        displayName: formName || undefined,
                        role: formRole,
                        companyIds: formCompanyIds,
                    }),
                })
            }
            resetForm()
            await loadAdmins()
        } catch (e) {
            setFormError(e instanceof Error ? e.message : 'Failed to save')
        }
        setSaving(false)
    }

    async function handleDelete(id: string, email: string) {
        if (!confirm(`Delete admin "${email}"? This cannot be undone.`)) return
        try {
            await apiFetch(`/dashboard/admins/${id}`, { method: 'DELETE' })
            await loadAdmins()
        } catch (e) {
            alert(e instanceof Error ? e.message : 'Delete failed')
        }
    }

    async function handleToggleActive(a: AdminUser) {
        try {
            await apiFetch(`/dashboard/admins/${a.id}`, {
                method: 'PUT',
                body: JSON.stringify({ isActive: !a.is_active }),
            })
            await loadAdmins()
        } catch {
            /* ignore */
        }
    }

    function toggleCompany(cid: string) {
        setFormCompanyIds((prev) => (prev.includes(cid) ? prev.filter((x) => x !== cid) : [...prev, cid]))
    }

    if (loading) return <div className="text-sm text-gray-400">Loading admins...</div>

    return (
        <div className="bg-white rounded-xl shadow-sm border p-6 space-y-4">
            <div className="flex items-center justify-between">
                <h3 className="font-semibold text-lg">User Management</h3>
                <button
                    onClick={() => {
                        resetForm()
                        setShowForm(true)
                    }}
                    className="px-3 py-1.5 text-sm font-medium bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
                >
                    + Add User
                </button>
            </div>

            {/* Add/Edit Form */}
            {showForm && (
                <div className="bg-gray-50 rounded-lg border p-5 space-y-4">
                    <h4 className="font-medium text-sm text-gray-700">{editingId ? 'Edit User' : 'Create New User'}</h4>

                    {formError && (
                        <div className="p-2 bg-red-50 border border-red-200 rounded text-sm text-red-700">
                            {formError}
                        </div>
                    )}

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div>
                            <label className="block text-xs font-medium text-gray-600 mb-1">Email</label>
                            <input
                                type="email"
                                value={formEmail}
                                onChange={(e) => setFormEmail(e.target.value)}
                                disabled={!!editingId}
                                className="w-full px-3 py-2 border rounded-lg text-sm disabled:bg-gray-100"
                                placeholder="user@company.com"
                            />
                        </div>
                        <div>
                            <label className="block text-xs font-medium text-gray-600 mb-1">
                                {editingId ? 'New Password (leave blank to keep)' : 'Password'}
                            </label>
                            <input
                                type="password"
                                value={formPassword}
                                onChange={(e) => setFormPassword(e.target.value)}
                                className="w-full px-3 py-2 border rounded-lg text-sm"
                                placeholder={editingId ? 'Leave blank to keep current' : 'Min 6 characters'}
                            />
                        </div>
                        <div>
                            <label className="block text-xs font-medium text-gray-600 mb-1">Display Name</label>
                            <input
                                type="text"
                                value={formName}
                                onChange={(e) => setFormName(e.target.value)}
                                className="w-full px-3 py-2 border rounded-lg text-sm"
                                placeholder="John Doe"
                            />
                        </div>
                        <div>
                            <label className="block text-xs font-medium text-gray-600 mb-1">Role</label>
                            <select
                                value={formRole}
                                onChange={(e) => setFormRole(e.target.value)}
                                className="w-full px-3 py-2 border rounded-lg text-sm"
                            >
                                <option value="company_admin">Company Admin</option>
                                <option value="superadmin">Super Admin</option>
                            </select>
                        </div>
                    </div>

                    {formRole === 'company_admin' && companies.length > 0 && (
                        <div>
                            <label className="block text-xs font-medium text-gray-600 mb-2">Company Access</label>
                            <div className="space-y-1.5">
                                {companies.map((c) => (
                                    <label key={c.id} className="flex items-center gap-2 text-sm cursor-pointer">
                                        <input
                                            type="checkbox"
                                            checked={formCompanyIds.includes(c.id)}
                                            onChange={() => toggleCompany(c.id)}
                                            className="rounded"
                                        />
                                        {c.tally_company_name}
                                    </label>
                                ))}
                            </div>
                        </div>
                    )}

                    <div className="flex gap-2">
                        <button
                            onClick={handleSave}
                            disabled={saving}
                            className="px-4 py-2 text-sm font-medium bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors"
                        >
                            {saving ? 'Saving...' : editingId ? 'Update User' : 'Create User'}
                        </button>
                        <button
                            onClick={resetForm}
                            className="px-4 py-2 text-sm font-medium text-gray-600 bg-gray-100 rounded-lg hover:bg-gray-200 transition-colors"
                        >
                            Cancel
                        </button>
                    </div>
                </div>
            )}

            {/* Admin list */}
            <div className="divide-y">
                {admins.map((a) => (
                    <div key={a.id} className="flex items-center justify-between py-3 gap-4">
                        <div className="flex items-center gap-3 min-w-0">
                            <div className="w-9 h-9 rounded-full bg-blue-100 flex items-center justify-center text-blue-700 font-bold text-sm shrink-0">
                                {(a.display_name || a.email)[0].toUpperCase()}
                            </div>
                            <div className="min-w-0">
                                <div className="flex items-center gap-2">
                                    <span className="font-medium text-sm text-gray-900 truncate">
                                        {a.display_name || a.email}
                                    </span>
                                    <span
                                        className={`text-xs font-medium px-1.5 py-0.5 rounded-full ${
                                            a.role === 'superadmin'
                                                ? 'bg-purple-100 text-purple-700'
                                                : 'bg-blue-100 text-blue-700'
                                        }`}
                                    >
                                        {a.role === 'superadmin' ? 'Super' : 'Admin'}
                                    </span>
                                    {!a.is_active && (
                                        <span className="text-xs font-medium px-1.5 py-0.5 rounded-full bg-red-100 text-red-700">
                                            Disabled
                                        </span>
                                    )}
                                </div>
                                <div className="text-xs text-gray-400 truncate">{a.email}</div>
                                {a.companies.length > 0 && (
                                    <div className="text-xs text-gray-400 mt-0.5">
                                        {a.companies.map((c) => c.name).join(', ')}
                                    </div>
                                )}
                            </div>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                            <span className="text-xs text-gray-400 hidden md:inline">
                                {a.last_login_at
                                    ? `Last login: ${new Date(a.last_login_at).toLocaleDateString()}`
                                    : 'Never logged in'}
                            </span>
                            <button
                                onClick={() => handleToggleActive(a)}
                                className={`text-xs px-2 py-1 rounded border font-medium ${
                                    a.is_active
                                        ? 'text-amber-700 border-amber-200 bg-amber-50 hover:bg-amber-100'
                                        : 'text-green-700 border-green-200 bg-green-50 hover:bg-green-100'
                                }`}
                            >
                                {a.is_active ? 'Disable' : 'Enable'}
                            </button>
                            <button
                                onClick={() => startEdit(a)}
                                className="text-xs px-2 py-1 rounded border text-blue-700 border-blue-200 bg-blue-50 hover:bg-blue-100 font-medium"
                            >
                                Edit
                            </button>
                            <button
                                onClick={() => handleDelete(a.id, a.email)}
                                className="text-xs px-2 py-1 rounded border text-red-700 border-red-200 bg-red-50 hover:bg-red-100 font-medium"
                            >
                                Delete
                            </button>
                        </div>
                    </div>
                ))}
                {admins.length === 0 && (
                    <div className="py-4 text-center text-sm text-gray-400">No admin users found.</div>
                )}
            </div>
        </div>
    )
}
