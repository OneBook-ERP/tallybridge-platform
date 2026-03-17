import { useState, useRef, useEffect } from 'react'
import { detectPlatform, platformLabel, downloadUrl, type PlatformKey } from '../lib/platform-detect'

const ALL_PLATFORMS: PlatformKey[] = ['windows-x64', 'windows-x86', 'windows-arm64']

interface DownloadButtonProps {
    /** Visual variant */
    variant?: 'primary' | 'ghost'
    className?: string
}

export default function DownloadButton({ variant = 'primary', className = '' }: DownloadButtonProps) {
    const [open, setOpen] = useState(false)
    const [detected] = useState<PlatformKey>(detectPlatform)
    const ref = useRef<HTMLDivElement>(null)

    // Close dropdown on outside click
    useEffect(() => {
        function onClickOutside(e: MouseEvent) {
            if (ref.current && !ref.current.contains(e.target as Node)) {
                setOpen(false)
            }
        }
        document.addEventListener('mousedown', onClickOutside)
        return () => document.removeEventListener('mousedown', onClickOutside)
    }, [])

    const primaryStyle =
        variant === 'primary' ? 'bg-blue-600 text-white hover:bg-blue-700' : 'bg-white/10 text-white hover:bg-white/20'

    const chevronStyle =
        variant === 'primary' ? 'border-blue-500 hover:bg-blue-800' : 'border-white/20 hover:bg-white/10'

    return (
        <div ref={ref} className={`relative inline-flex ${className}`}>
            {/* Main button — downloads detected platform */}
            <a
                href={downloadUrl(detected)}
                className={`inline-flex items-center gap-2 px-4 py-2 rounded-l-lg text-sm font-medium transition-colors ${primaryStyle}`}
            >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                    <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3"
                    />
                </svg>
                Download for {platformLabel(detected)}
            </a>

            {/* Dropdown trigger */}
            <button
                onClick={() => setOpen((prev) => !prev)}
                className={`px-2 py-2 rounded-r-lg border-l text-sm transition-colors ${primaryStyle} ${chevronStyle}`}
                aria-label="Other platforms"
            >
                <svg
                    className={`w-4 h-4 transition-transform ${open ? 'rotate-180' : ''}`}
                    fill="none"
                    viewBox="0 0 24 24"
                    strokeWidth={2}
                    stroke="currentColor"
                >
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
                </svg>
            </button>

            {/* Dropdown menu */}
            {open && (
                <div className="absolute right-0 top-full mt-1 w-56 bg-white rounded-lg shadow-lg border border-gray-200 py-1 z-50">
                    <div className="px-3 py-1.5 text-xs font-medium text-gray-400 uppercase tracking-wider">
                        All platforms
                    </div>
                    {ALL_PLATFORMS.map((plat) => (
                        <a
                            key={plat}
                            href={downloadUrl(plat)}
                            onClick={() => setOpen(false)}
                            className={`block px-3 py-2 text-sm hover:bg-gray-50 transition-colors ${
                                plat === detected ? 'text-blue-600 font-medium' : 'text-gray-700'
                            }`}
                        >
                            {platformLabel(plat)}
                            {plat === detected && (
                                <span className="ml-2 text-xs text-blue-400 font-normal">(detected)</span>
                            )}
                        </a>
                    ))}
                </div>
            )}
        </div>
    )
}
