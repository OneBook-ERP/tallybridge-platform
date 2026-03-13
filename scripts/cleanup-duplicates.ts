/**
 * Cleanup script: delete duplicate documents in ERPNext.
 * Keeps the FIRST (oldest) document for each custom_tally_guid, cancels+deletes the rest.
 *
 * Usage: npx tsx scripts/cleanup-duplicates.ts
 */
import 'dotenv/config'

const BASE_URL = process.env.ERPNEXT_URL || 'https://tally.zenpivot.in'
const AUTH = `token ${process.env.ERPNEXT_API_KEY || '2015ad50ead346b'}:${process.env.ERPNEXT_API_SECRET || 'fde5d28a4c3dbe1'}`

async function apiCall(path: string, method = 'GET', body?: unknown) {
    const init: RequestInit = {
        method,
        headers: { 'Authorization': AUTH, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
    }
    const res = await fetch(`${BASE_URL}${path}`, init)
    if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(`${method} ${path}: ${res.status} ${text.slice(0, 200)}`)
    }
    return res.json() as Promise<{ data?: unknown; message?: unknown }>
}

async function getList(doctype: string, fields: string[], filters: string[][], limit = 0, orderBy = 'name asc') {
    const params = new URLSearchParams({
        fields: JSON.stringify(fields),
        filters: JSON.stringify(filters),
        order_by: orderBy,
        limit_page_length: String(limit || 0),
    })
    const res = await apiCall(`/api/resource/${encodeURIComponent(doctype)}?${params}`)
    return (res.data ?? []) as Array<Record<string, string>>
}

async function cancelDoc(doctype: string, name: string) {
    await apiCall(`/api/method/frappe.client.cancel`, 'POST', { doctype, name })
}

async function deleteDoc(doctype: string, name: string) {
    // Use frappe.client.delete with force to remove linked GL entries
    await apiCall(`/api/method/frappe.client.delete`, 'POST', { doctype, name })
}

async function cleanupDoctype(doctype: string) {
    console.log(`\n=== Cleaning up ${doctype} ===`)

    // Get all docs with tally GUID, ordered by name (oldest first)
    const docs = await getList(doctype, ['name', 'custom_tally_guid', 'docstatus'], [['custom_tally_guid', '!=', '']], 0, 'name asc')
    console.log(`Total ${doctype} with GUID: ${docs.length}`)

    // Group by GUID
    const byGuid = new Map<string, Array<{ name: string; docstatus: string }>>()
    for (const doc of docs) {
        const guid = doc.custom_tally_guid
        if (!byGuid.has(guid)) byGuid.set(guid, [])
        byGuid.get(guid)!.push({ name: doc.name, docstatus: doc.docstatus })
    }

    let deleted = 0
    let errors = 0
    const dupeGuids = [...byGuid.entries()].filter(([, list]) => list.length > 1)
    console.log(`Duplicate GUIDs: ${dupeGuids.length}`)

    for (const [guid, list] of dupeGuids) {
        // Keep first, delete rest
        const [keep, ...extras] = list
        for (const doc of extras) {
            try {
                // Cancel if submitted (docstatus=1)
                if (doc.docstatus === '1') {
                    await cancelDoc(doctype, doc.name)
                }
                await deleteDoc(doctype, doc.name)
                deleted++
                if (deleted % 50 === 0) console.log(`  Deleted ${deleted} duplicates so far...`)
            } catch (err) {
                errors++
                console.error(`  Failed to delete ${doc.name}: ${(err as Error).message.slice(0, 100)}`)
            }
        }
    }

    console.log(`${doctype}: deleted ${deleted}, errors ${errors}, kept ${byGuid.size} unique`)
}

async function main() {
    console.log('ERPNext Duplicate Cleanup')
    console.log(`Target: ${BASE_URL}`)

    for (const dt of ['Journal Entry', 'Sales Invoice', 'Purchase Invoice', 'Payment Entry']) {
        await cleanupDoctype(dt)
    }

    console.log('\nDone!')
}

main().catch(console.error)
