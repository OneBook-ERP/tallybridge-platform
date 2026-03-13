import { describe, it, expect } from 'vitest'
import { generateToken, hashToken, safeCompare, hmacSha256, verifyWebhookSignature } from './crypto'

describe('generateToken', () => {
    it('generates a base64url string', () => {
        const token = generateToken()
        expect(token).toMatch(/^[A-Za-z0-9_-]+$/)
    })

    it('generates unique tokens each call', () => {
        const t1 = generateToken()
        const t2 = generateToken()
        expect(t1).not.toBe(t2)
    })

    it('respects byte length parameter', () => {
        const short = generateToken(16)
        const long = generateToken(64)
        expect(short.length).toBeLessThan(long.length)
    })
})

describe('hashToken', () => {
    it('returns SHA-256 hex digest', () => {
        const hash = hashToken('test-token')
        expect(hash).toHaveLength(64)
        expect(hash).toMatch(/^[0-9a-f]+$/)
    })

    it('is deterministic', () => {
        expect(hashToken('same')).toBe(hashToken('same'))
    })

    it('produces different hashes for different inputs', () => {
        expect(hashToken('a')).not.toBe(hashToken('b'))
    })
})

describe('safeCompare', () => {
    it('returns true for identical strings', () => {
        expect(safeCompare('hello', 'hello')).toBe(true)
    })

    it('returns false for different strings', () => {
        expect(safeCompare('hello', 'world')).toBe(false)
    })

    it('returns false for different length strings', () => {
        expect(safeCompare('short', 'longer string')).toBe(false)
    })
})

describe('hmacSha256', () => {
    it('produces hex HMAC', () => {
        const hmac = hmacSha256('secret', 'payload')
        expect(hmac).toMatch(/^[0-9a-f]+$/)
        expect(hmac).toHaveLength(64)
    })

    it('is deterministic', () => {
        expect(hmacSha256('s', 'p')).toBe(hmacSha256('s', 'p'))
    })

    it('changes with different secrets', () => {
        expect(hmacSha256('s1', 'p')).not.toBe(hmacSha256('s2', 'p'))
    })
})

describe('verifyWebhookSignature', () => {
    it('returns true for valid signature', () => {
        const secret = 'webhook-secret'
        const payload = '{"doctype":"Sales Invoice"}'
        const sig = `hmac-sha256=${hmacSha256(secret, payload)}`
        expect(verifyWebhookSignature(secret, payload, sig)).toBe(true)
    })

    it('returns false for invalid signature', () => {
        expect(verifyWebhookSignature('secret', 'payload', 'hmac-sha256=wrong')).toBe(false)
    })

    it('returns false for malformed signature', () => {
        expect(verifyWebhookSignature('secret', 'payload', 'not-even-close')).toBe(false)
    })
})
