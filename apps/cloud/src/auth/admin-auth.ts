/**
 * Admin authentication — password hashing + JWT token management.
 * Uses bcryptjs for password hashing and jose for JWT operations.
 */
import bcrypt from 'bcryptjs'
import { SignJWT, jwtVerify, type JWTPayload } from 'jose'
import { env } from '../lib/env'

const BCRYPT_ROUNDS = 12
const ACCESS_TOKEN_TTL = '1h'
const REFRESH_TOKEN_TTL = '7d'
const ISSUER = 'tallybridge'

function getSecret() {
    return new TextEncoder().encode(env.JWT_SECRET)
}

export async function hashPassword(plain: string): Promise<string> {
    return bcrypt.hash(plain, BCRYPT_ROUNDS)
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
    return bcrypt.compare(plain, hash)
}

export interface AdminTokenPayload extends JWTPayload {
    sub: string
    email: string
    role: 'superadmin' | 'company_admin'
    type: 'access' | 'refresh'
}

export async function signAccessToken(admin: { id: string; email: string; role: string }): Promise<string> {
    return new SignJWT({
        email: admin.email,
        role: admin.role,
        type: 'access',
    })
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject(admin.id)
        .setIssuer(ISSUER)
        .setIssuedAt()
        .setExpirationTime(ACCESS_TOKEN_TTL)
        .sign(getSecret())
}

export async function signRefreshToken(admin: { id: string }): Promise<string> {
    return new SignJWT({ type: 'refresh' })
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject(admin.id)
        .setIssuer(ISSUER)
        .setIssuedAt()
        .setExpirationTime(REFRESH_TOKEN_TTL)
        .sign(getSecret())
}

export async function verifyToken(token: string): Promise<AdminTokenPayload> {
    const { payload } = await jwtVerify(token, getSecret(), { issuer: ISSUER })
    return payload as AdminTokenPayload
}
