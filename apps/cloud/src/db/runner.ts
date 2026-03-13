/**
 * Migration runner — reads numbered .sql files from the migrations/ directory
 * and executes them in order using a schema_migrations tracking table.
 * Idempotent: already-applied migrations are skipped.
 *
 * Run: npm run migrate  (or)  tsx src/db/runner.ts
 */
import { readdir, readFile } from 'fs/promises'
import { join } from 'path'
import postgres from 'postgres'
import dotenv from 'dotenv'

dotenv.config()

const DATABASE_URL = process.env.DATABASE_URL
if (!DATABASE_URL) {
    console.error('DATABASE_URL is not set')
    process.exit(1)
}

async function run(): Promise<void> {
    const sql = postgres(DATABASE_URL as string, { max: 1 })

    try {
        // Ensure the tracking table exists first (run outside a transaction).
        await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename    TEXT PRIMARY KEY,
        applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `)

        const migrationsDir = join(__dirname, 'migrations')
        const files = (await readdir(migrationsDir))
            .filter((f) => f.endsWith('.sql'))
            .sort()

        for (const file of files) {
            const existing = await sql.unsafe(
                `SELECT 1 FROM schema_migrations WHERE filename = $1`,
                [file]
            )
            if (existing.length > 0) {
                console.log(`  ✓ ${file} (already applied)`)
                continue
            }

            const content = await readFile(join(migrationsDir, file), 'utf-8')

            // Run migration + tracking insert together in a single unsafe call sequence.
            await sql.unsafe(content)
            await sql.unsafe(
                `INSERT INTO schema_migrations (filename) VALUES ($1)`,
                [file]
            )

            console.log(`  ✅ ${file} applied`)
        }

        console.log('\nAll migrations complete.')
    } finally {
        await sql.end()
    }
}

run().catch((err) => {
    console.error('Migration failed:', err)
    process.exit(1)
})
