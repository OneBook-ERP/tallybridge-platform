/**
 * Download routes — serves connector binaries by proxying GitHub releases.
 * Uses GitHub API to find the latest release, then streams the asset.
 *
 * GET /download/connector?platform=windows-x64  → proxy binary download
 * GET /download/connector?platform=windows-arm64
 * GET /download/connector?platform=darwin-arm64  → proxy .dmg/.zip
 * GET /download/connector                        → returns available platforms + versions
 */
import type { FastifyPluginAsync } from 'fastify'
import { env } from '../../lib/env'
import { logger } from '../../lib/logger'

interface GitHubAsset {
    id: number
    name: string
    browser_download_url: string
    size: number
    content_type: string
}

interface GitHubRelease {
    tag_name: string
    name: string
    published_at: string
    assets: GitHubAsset[]
}

// Cache the release info for 5 minutes to avoid hitting GitHub rate limits
let cachedRelease: GitHubRelease | null = null
let cacheTimestamp = 0
const CACHE_TTL = 5 * 60 * 1000

function githubHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'TallyBridge-Cloud',
    }
    if (env.GITHUB_TOKEN) {
        headers.Authorization = `Bearer ${env.GITHUB_TOKEN}`
    }
    return headers
}

async function getLatestRelease(): Promise<GitHubRelease | null> {
    if (cachedRelease && Date.now() - cacheTimestamp < CACHE_TTL) {
        return cachedRelease
    }

    const repo = env.GITHUB_CONNECTOR_REPO
    try {
        const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
            headers: githubHeaders(),
        })
        if (!res.ok) {
            logger.warn({ status: res.status, repo }, 'Failed to fetch GitHub release')
            return cachedRelease // return stale cache if available
        }
        cachedRelease = (await res.json()) as GitHubRelease
        cacheTimestamp = Date.now()
        return cachedRelease
    } catch (err) {
        logger.warn({ err, repo }, 'GitHub API error')
        return cachedRelease
    }
}

// Map platform query param to asset name patterns
const PLATFORM_PATTERNS: Record<string, { patterns: string[]; label: string }> = {
    'windows-x64': { patterns: ['setup-', '-setup-'], label: 'Windows (64-bit)' },
    'windows-x86': { patterns: ['setup-', '-setup-'], label: 'Windows (32-bit)' },
    'windows-arm64': { patterns: ['setup-', '-setup-'], label: 'Windows (ARM64)' },
}

/**
 * Match setup EXE by architecture.
 * Naming convention: tallybridge-connector-setup-{version}.exe        → x64 (no arch suffix)
 *                    tallybridge-connector-setup-{version}-x86.exe    → x86
 *                    tallybridge-connector-setup-{version}-arm64.exe  → arm64
 */
function findSetupAsset(release: GitHubRelease, platform: string): GitHubAsset | null {
    const setupAssets = release.assets.filter((a) => a.name.toLowerCase().includes('setup'))
    if (setupAssets.length === 0) return null

    switch (platform) {
        case 'windows-arm64':
            return setupAssets.find((a) => a.name.toLowerCase().includes('arm64')) ?? null
        case 'windows-x86':
            return setupAssets.find((a) => a.name.toLowerCase().includes('x86')) ?? null
        case 'windows-x64':
        default:
            // The x64 setup has no architecture suffix — pick the one that is NOT arm64 and NOT x86
            return (
                setupAssets.find(
                    (a) => !a.name.toLowerCase().includes('arm64') && !a.name.toLowerCase().includes('x86'),
                ) ?? null
            )
    }
}

function findAsset(release: GitHubRelease, platform: string): GitHubAsset | null {
    if (!PLATFORM_PATTERNS[platform]) return null
    return findSetupAsset(release, platform)
}

export const downloadRoutes: FastifyPluginAsync = async (app) => {
    // GET /download/connector — list available downloads or proxy a specific platform binary
    app.get<{ Querystring: { platform?: string } }>('/download/connector', async (req, reply) => {
        const release = await getLatestRelease()

        if (!release) {
            reply.code(503).send({
                error: 'UNAVAILABLE',
                message: 'Could not fetch latest release. Please try again later.',
            })
            return
        }

        const { platform } = req.query

        // If a specific platform is requested, proxy the binary
        if (platform) {
            const asset = findAsset(release, platform)
            if (!asset) {
                reply.code(404).send({
                    error: 'NOT_FOUND',
                    message: `No download available for platform "${platform}"`,
                    availablePlatforms: Object.keys(PLATFORM_PATTERNS),
                })
                return
            }

            // For private repos — proxy the binary through our server using asset ID
            if (env.GITHUB_TOKEN) {
                const repo = env.GITHUB_CONNECTOR_REPO
                const proxyRes = await fetch(`https://api.github.com/repos/${repo}/releases/assets/${asset.id}`, {
                    headers: {
                        Accept: 'application/octet-stream',
                        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
                        'User-Agent': 'TallyBridge-Cloud',
                    },
                    redirect: 'follow',
                })

                if (!proxyRes.ok || !proxyRes.body) {
                    logger.warn({ status: proxyRes.status, asset: asset.name }, 'Failed to proxy GitHub asset')
                    reply.code(502).send({ error: 'PROXY_ERROR', message: 'Failed to fetch release asset' })
                    return
                }

                reply
                    .header('Content-Type', asset.content_type || 'application/octet-stream')
                    .header('Content-Disposition', `attachment; filename="${asset.name}"`)
                    .header('Content-Length', asset.size)

                // Stream the response body through
                return reply.send(proxyRes.body)
            }

            // Public repo — just redirect
            reply.redirect(asset.browser_download_url)
            return
        }

        // No platform specified — return available downloads with labels
        const downloads = Object.entries(PLATFORM_PATTERNS)
            .map(([plat, { label }]) => {
                const asset = findAsset(release, plat)
                return asset
                    ? {
                          platform: plat,
                          label,
                          fileName: asset.name,
                          size: asset.size,
                          downloadUrl: `/download/connector?platform=${plat}`,
                      }
                    : null
            })
            .filter(Boolean)

        return {
            version: release.tag_name,
            releaseName: release.name,
            publishedAt: release.published_at,
            downloads,
        }
    })
}
