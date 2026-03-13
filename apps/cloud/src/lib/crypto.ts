import { createHmac, randomBytes, timingSafeEqual, createHash } from 'crypto'

/**
 * Generate a cryptographically random URL-safe token string.
 * @param bytes  Number of random bytes (output will be ~1.33× longer as base64url)
 */
export function generateToken(bytes = 32): string {
    return randomBytes(bytes).toString('base64url')
}

/**
 * SHA-256 hash of a string — used for storing machine tokens in DB without
 * storing the raw secret (similar to password hashing but for tokens).
 */
export function hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex')
}

/**
 * Timing-safe comparison of two token strings.
 * Prevents timing attacks when validating machine tokens.
 */
export function safeCompare(a: string, b: string): boolean {
    if (a.length !== b.length) return false
    const bufA = Buffer.from(a)
    const bufB = Buffer.from(b)
    return timingSafeEqual(bufA, bufB)
}

/**
 * Compute HMAC-SHA256 of payload using secret.
 * Used for ERPNext webhook signature verification.
 */
export function hmacSha256(secret: string, payload: string): string {
    return createHmac('sha256', secret).update(payload).digest('hex')
}

/**
 * Verify an ERPNext webhook signature.
 * ERPNext sends: X-Frappe-Signature: hmac-sha256=<hex>
 */
export function verifyWebhookSignature(secret: string, payload: string, signature: string): boolean {
    const expected = `hmac-sha256=${hmacSha256(secret, payload)}`
    try {
        return safeCompare(expected, signature)
    } catch {
        return false
    }
}
