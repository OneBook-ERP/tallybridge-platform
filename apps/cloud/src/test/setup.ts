/**
 * Vitest setup — runs before all test files.
 * Sets env vars so env.ts doesn't call process.exit(1).
 */
process.env.DATABASE_URL = 'postgres://test:test@localhost:5432/test'
process.env.JWT_SECRET = 'test-jwt-secret-that-is-at-least-32-chars-long'
process.env.REDIS_URL = 'redis://localhost:6379'
process.env.NODE_ENV = 'test'
