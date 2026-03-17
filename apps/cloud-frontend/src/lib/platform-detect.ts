/**
 * Detect the user's Windows architecture from browser signals
 * and return the matching download URL.
 */

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? '/api'

export type PlatformKey = 'windows-x64' | 'windows-x86' | 'windows-arm64'

const PLATFORM_LABELS: Record<PlatformKey, string> = {
    'windows-x64': 'Windows (64-bit)',
    'windows-x86': 'Windows (32-bit)',
    'windows-arm64': 'Windows (ARM64)',
}

export function detectPlatform(): PlatformKey {
    const ua = navigator.userAgent.toLowerCase()
    if (ua.includes('arm') || ua.includes('aarch64')) return 'windows-arm64'
    if (ua.includes('wow64') || ua.includes('win64') || ua.includes('x64') || ua.includes('x86_64'))
        return 'windows-x64'
    return 'windows-x64' // default to 64-bit
}

export function platformLabel(key: PlatformKey): string {
    return PLATFORM_LABELS[key] ?? key
}

export function downloadUrl(platform: PlatformKey): string {
    return `${API_BASE}/download/connector?platform=${platform}`
}
