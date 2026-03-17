import postgres from 'postgres'
import { env } from '../lib/env'
import { logger } from '../lib/logger'

// The postgres package uses tagged template literals — no placeholder injection needed.
// All user values must be passed as template interpolations to prevent SQL injection.
export const sql = postgres(env.DATABASE_URL, {
    max: 10,
    idle_timeout: 30,
    connect_timeout: 10,
    onnotice: (notice) => logger.debug({ notice }, 'pg notice'),
})

export type SQL = typeof sql

/**
 * Wrapper for sql.json() that accepts any serializable value.
 * postgres.js JSONValue type is stricter than what the runtime actually handles.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const jsonb = (value: unknown) => sql.json(value as any)

/** Verify the database connection on startup. */
export async function checkConnection(): Promise<void> {
    await sql`SELECT 1`
    logger.info('PostgreSQL connected')
}

/** Close the pool — call on process exit. */
export async function closeConnection(): Promise<void> {
    await sql.end()
    logger.info('PostgreSQL connection closed')
}
