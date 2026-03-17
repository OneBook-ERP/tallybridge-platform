import { useState, useEffect } from 'react'
import { useAuth } from '../../lib/auth'
import { useNavigate, Link } from 'react-router-dom'
import DownloadButton from '../../components/download-button'

const features = [
    {
        title: 'Real-Time Sync',
        description: 'Automatically sync vouchers, ledgers, and stock items between Tally and ERPNext in real-time.',
        icon: '⚡',
    },
    {
        title: 'Bidirectional Flow',
        description: 'Changes in Tally reflect in ERPNext and vice-versa. No manual data entry required.',
        icon: '🔄',
    },
    {
        title: 'Smart Conflict Detection',
        description: 'Detects and flags conflicts when the same record is modified on both sides simultaneously.',
        icon: '🛡️',
    },
    {
        title: 'Exception Management',
        description:
            'Automatic exception tiers — auto-retry, flag for review, or block. Nothing falls through the cracks.',
        icon: '📋',
    },
    {
        title: 'Multi-Company Support',
        description: 'Manage multiple Tally companies from a single dashboard with role-based access control.',
        icon: '🏢',
    },
]

export default function LoginPage() {
    const { login, isAuthenticated } = useAuth()
    const navigate = useNavigate()
    const [email, setEmail] = useState('')
    const [password, setPassword] = useState('')
    const [error, setError] = useState('')
    const [loading, setLoading] = useState(false)
    const [activeFeature, setActiveFeature] = useState(0)

    // Auto-rotate features
    useEffect(() => {
        const timer = setInterval(() => {
            setActiveFeature((prev) => (prev + 1) % features.length)
        }, 4000)
        return () => clearInterval(timer)
    }, [])

    // Redirect if already authenticated
    useEffect(() => {
        if (isAuthenticated) navigate('/', { replace: true })
    }, [isAuthenticated, navigate])

    async function handleSubmit(e: React.FormEvent) {
        e.preventDefault()
        setError('')
        setLoading(true)
        try {
            await login(email, password)
            navigate('/', { replace: true })
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Login failed')
        } finally {
            setLoading(false)
        }
    }

    return (
        <div className="min-h-screen flex">
            {/* Left — Feature carousel */}
            <div className="hidden lg:flex lg:w-1/2 bg-gradient-to-br from-blue-600 via-blue-700 to-indigo-800 text-white flex-col justify-between p-12">
                <div>
                    <h1 className="text-3xl font-bold tracking-tight">TallyBridge</h1>
                    <p className="mt-2 text-blue-200 text-lg">Tally ↔ ERPNext Sync Platform</p>
                </div>

                <div className="flex-1 flex flex-col justify-center">
                    <div className="relative min-h-[200px]">
                        {features.map((feature, idx) => (
                            <div
                                key={idx}
                                className={`absolute inset-0 transition-all duration-500 ${
                                    idx === activeFeature
                                        ? 'opacity-100 translate-y-0'
                                        : 'opacity-0 translate-y-4 pointer-events-none'
                                }`}
                            >
                                <span className="text-5xl">{feature.icon}</span>
                                <h2 className="mt-4 text-2xl font-semibold">{feature.title}</h2>
                                <p className="mt-3 text-blue-100 text-lg leading-relaxed max-w-md">
                                    {feature.description}
                                </p>
                            </div>
                        ))}
                    </div>

                    {/* Dots */}
                    <div className="flex gap-2 mt-8">
                        {features.map((_, idx) => (
                            <button
                                key={idx}
                                onClick={() => setActiveFeature(idx)}
                                className={`w-2.5 h-2.5 rounded-full transition-all ${
                                    idx === activeFeature ? 'bg-white w-8' : 'bg-blue-400'
                                }`}
                            />
                        ))}
                    </div>
                </div>

                <div className="space-y-3">
                    <p className="text-blue-200 text-sm">Need the desktop connector?</p>
                    <DownloadButton variant="ghost" />
                </div>
            </div>

            {/* Right — Login form */}
            <div className="flex-1 flex items-center justify-center p-8 bg-gray-50">
                <div className="w-full max-w-md">
                    {/* Mobile logo */}
                    <div className="lg:hidden mb-8">
                        <h1 className="text-2xl font-bold text-gray-900">TallyBridge</h1>
                        <p className="text-gray-500">Tally ↔ ERPNext Sync Platform</p>
                    </div>

                    <div className="bg-white rounded-2xl shadow-sm border border-gray-200 p-8">
                        <h2 className="text-xl font-semibold text-gray-900">Sign in to your account</h2>
                        <p className="mt-1 text-sm text-gray-500">Access your sync dashboard</p>

                        <form onSubmit={handleSubmit} className="mt-6 space-y-5">
                            {error && (
                                <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
                                    {error}
                                </div>
                            )}

                            <div>
                                <label htmlFor="email" className="block text-sm font-medium text-gray-700 mb-1">
                                    Email address
                                </label>
                                <input
                                    id="email"
                                    type="email"
                                    required
                                    autoComplete="email"
                                    value={email}
                                    onChange={(e) => setEmail(e.target.value)}
                                    className="w-full px-3 py-2.5 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                                    placeholder="admin@company.com"
                                />
                            </div>

                            <div>
                                <label htmlFor="password" className="block text-sm font-medium text-gray-700 mb-1">
                                    Password
                                </label>
                                <input
                                    id="password"
                                    type="password"
                                    required
                                    autoComplete="current-password"
                                    value={password}
                                    onChange={(e) => setPassword(e.target.value)}
                                    className="w-full px-3 py-2.5 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                                    placeholder="Enter your password"
                                />
                            </div>

                            <button
                                type="submit"
                                disabled={loading}
                                className="w-full py-2.5 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 text-white rounded-lg text-sm font-medium transition-colors"
                            >
                                {loading ? 'Signing in...' : 'Sign in'}
                            </button>
                        </form>

                        <p className="mt-5 text-center text-sm text-gray-500">
                            Don't have an account?{' '}
                            <Link to="/signup" className="text-blue-600 hover:text-blue-700 font-medium">
                                Sign up
                            </Link>
                        </p>
                    </div>

                    <p className="mt-6 text-center text-xs text-gray-400">
                        TallyBridge Platform &middot; Powered by OneBook
                    </p>
                </div>
            </div>
        </div>
    )
}
