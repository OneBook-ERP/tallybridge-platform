/**
 * CLI script to create an admin user.
 * Usage: npm run create-admin -- --email admin@example.com --password secret123 --role superadmin
 */
import { sql } from '../db/db'
import { hashPassword } from '../auth/admin-auth'

async function main() {
    const args = process.argv.slice(2)
    const get = (flag: string): string | undefined => {
        const idx = args.indexOf(flag)
        return idx >= 0 ? args[idx + 1] : undefined
    }

    const email = get('--email')
    const password = get('--password')
    const role = get('--role') ?? 'superadmin'
    const displayName = get('--name')

    if (!email || !password) {
        console.error(
            'Usage: npm run create-admin -- --email <email> --password <password> [--role superadmin|company_admin] [--name "Display Name"]',
        )
        process.exit(1)
    }

    if (!['superadmin', 'company_admin'].includes(role)) {
        console.error('Role must be "superadmin" or "company_admin"')
        process.exit(1)
    }

    const passwordHash = await hashPassword(password)

    const [admin] = await sql<{ id: string; email: string }[]>`
        INSERT INTO admins (email, password_hash, role, display_name)
        VALUES (${email.toLowerCase()}, ${passwordHash}, ${role}, ${displayName ?? null})
        ON CONFLICT (email) DO UPDATE SET
            password_hash = EXCLUDED.password_hash,
            role = EXCLUDED.role,
            display_name = COALESCE(EXCLUDED.display_name, admins.display_name),
            updated_at = now()
        RETURNING id, email
    `

    console.log(`✅ Admin created/updated: ${admin.email} (${role}) — id: ${admin.id}`)

    // If company_admin, optionally assign companies
    const companyIds = get('--companies')
    if (companyIds) {
        const ids = companyIds.split(',').map((s) => s.trim())
        for (const cid of ids) {
            await sql`
                INSERT INTO admin_company_access (admin_id, company_id)
                VALUES (${admin.id}, ${cid})
                ON CONFLICT DO NOTHING
            `
        }
        console.log(`  Assigned to ${ids.length} company(ies)`)
    }

    await sql.end()
}

main().catch((err) => {
    console.error('Failed:', err)
    process.exit(1)
})
