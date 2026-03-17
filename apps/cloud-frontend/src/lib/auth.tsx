/**
 * Auth context — stores JWT tokens, handles login/logout/refresh,
 * and injects Authorization header into apiFetch.
 */
import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react'

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? '/api'

interface Admin {
    id: string
    email: string
    role: 'superadmin' | 'company_admin'
    displayName: string | null
}

interface AuthState {
    accessToken: string | null
    refreshToken: string | null
    admin: Admin | null
}

interface AuthContextValue extends AuthState {
    login: (email: string, password: string) => Promise<void>
    signup: (email: string, password: string, displayName?: string) => Promise<void>
    logout: () => void
    isAuthenticated: boolean
    isLoading: boolean
}

const AuthContext = createContext<AuthContextValue | null>(null)

const STORAGE_KEY = 'tb_auth'

function loadFromStorage(): AuthState {
    try {
        const raw = localStorage.getItem(STORAGE_KEY)
        if (raw) return JSON.parse(raw)
    } catch {
        /* ignore corrupt storage */
    }
    return { accessToken: null, refreshToken: null, admin: null }
}

function saveToStorage(state: AuthState) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
}

function clearStorage() {
    localStorage.removeItem(STORAGE_KEY)
}

export function AuthProvider({ children }: { children: ReactNode }) {
    const [state, setState] = useState<AuthState>(loadFromStorage)
    const [isLoading, setIsLoading] = useState(true)

    // Validate token on mount
    useEffect(() => {
        if (!state.accessToken) {
            setIsLoading(false)
            return
        }

        // Try /auth/me to validate the token
        fetch(`${API_BASE}/auth/me`, {
            headers: { Authorization: `Bearer ${state.accessToken}` },
        })
            .then(async (res) => {
                if (res.ok) {
                    const data = await res.json()
                    const newState = { ...state, admin: data.admin }
                    setState(newState)
                    saveToStorage(newState)
                } else if (res.status === 401 && state.refreshToken) {
                    // Try refresh
                    await doRefresh(state.refreshToken)
                } else {
                    clearStorage()
                    setState({ accessToken: null, refreshToken: null, admin: null })
                }
            })
            .catch(() => {
                // Network error — keep current state, don't force logout
            })
            .finally(() => setIsLoading(false))
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    const doRefresh = useCallback(
        async (token: string) => {
            try {
                const res = await fetch(`${API_BASE}/auth/refresh`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ refreshToken: token }),
                })
                if (res.ok) {
                    const data = await res.json()
                    const newState: AuthState = {
                        accessToken: data.accessToken,
                        refreshToken: data.refreshToken,
                        admin: state.admin,
                    }
                    setState(newState)
                    saveToStorage(newState)
                    return data.accessToken as string
                }
            } catch {
                /* refresh failed */
            }

            clearStorage()
            setState({ accessToken: null, refreshToken: null, admin: null })
            return null
        },
        [state.admin],
    )

    const login = useCallback(async (email: string, password: string) => {
        const res = await fetch(`${API_BASE}/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password }),
        })

        if (!res.ok) {
            const body = await res.json().catch(() => ({ message: 'Login failed' }))
            throw new Error(body.message || 'Login failed')
        }

        const data = await res.json()
        const newState: AuthState = {
            accessToken: data.accessToken,
            refreshToken: data.refreshToken,
            admin: data.admin,
        }
        setState(newState)
        saveToStorage(newState)
    }, [])

    const signup = useCallback(async (email: string, password: string, displayName?: string) => {
        const res = await fetch(`${API_BASE}/auth/signup`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password, displayName: displayName || undefined }),
        })

        if (!res.ok) {
            const body = await res.json().catch(() => ({ message: 'Signup failed' }))
            throw new Error(body.message || 'Signup failed')
        }

        const data = await res.json()
        const newState: AuthState = {
            accessToken: data.accessToken,
            refreshToken: data.refreshToken,
            admin: data.admin,
        }
        setState(newState)
        saveToStorage(newState)
    }, [])

    const logout = useCallback(() => {
        clearStorage()
        setState({ accessToken: null, refreshToken: null, admin: null })
    }, [])

    return (
        <AuthContext.Provider
            value={{
                ...state,
                login,
                signup,
                logout,
                isAuthenticated: !!state.accessToken,
                isLoading,
            }}
        >
            {children}
        </AuthContext.Provider>
    )
}

export function useAuth() {
    const ctx = useContext(AuthContext)
    if (!ctx) throw new Error('useAuth must be used within AuthProvider')
    return ctx
}

/**
 * Returns the current access token for use in API calls.
 * Call this from api.ts to inject auth headers.
 */
export function getAccessToken(): string | null {
    try {
        const raw = localStorage.getItem(STORAGE_KEY)
        if (raw) {
            const parsed = JSON.parse(raw)
            return parsed.accessToken ?? null
        }
    } catch {
        /* ignore */
    }
    return null
}
