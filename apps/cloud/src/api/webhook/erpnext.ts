/**
 * POST /webhook/erpnext
 *
 * Receives ERPNext document-event webhooks and enqueues them as tally-write jobs
 * so the connector can write them back into Tally (ERP → Tally direction).
 *
 * Supported events: on_submit, on_cancel, on_update_after_submit
 * Supported doctypes: Sales Invoice, Purchase Invoice, Payment Entry, Journal Entry
 *
 * Set up in ERPNext: Settings > Integrations > Webhooks
 *   URL: http://<cloud>:3000/webhook/erpnext
 *   Request Structure: Form Data or JSON
 *   Events: on_submit, on_cancel
 */
import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { sql } from '../../db/db'
import { ERPNextClient } from '../../erpnext/client'
import { enqueueTallyWrite } from '../../queue/producer'
import { erpSalesToTally } from '../../transform/erp-to-tally/sales'
import { erpPurchaseToTally } from '../../transform/erp-to-tally/purchase'
import { erpPaymentToTally } from '../../transform/erp-to-tally/payment'
import { erpJournalToTally } from '../../transform/erp-to-tally/journal'
import { logger } from '../../lib/logger'
import type { CompanyConfig } from '../../types'

const SUPPORTED_DOCTYPES = ['Sales Invoice', 'Purchase Invoice', 'Payment Entry', 'Journal Entry'] as const
type SupportedDoctype = typeof SUPPORTED_DOCTYPES[number]

const WebhookBodySchema = z.object({
    doctype: z.string(),
    name: z.string(),
    event: z.string().optional(),   // on_submit | on_cancel | on_update_after_submit
})

export const erpnextWebhookRoute: FastifyPluginAsync = async (fastify) => {
    fastify.post<{ Body: unknown }>(
        '/webhook/erpnext',
        async (request, reply) => {
            const body = WebhookBodySchema.safeParse(request.body)
            if (!body.success) {
                logger.warn({ raw: request.body }, 'Webhook: invalid body')
                return reply.code(400).send({ error: 'Invalid body' })
            }

            const { doctype, name, event } = body.data

            // Skip if not a supported doctype
            if (!SUPPORTED_DOCTYPES.includes(doctype as SupportedDoctype)) {
                return reply.send({ ok: true, skipped: true, reason: `doctype ${doctype} not handled` })
            }

            // Skip loop-back: docs we wrote from Tally have custom_sync_source = 'TALLYBRIDGE'
            // ERPNext webhook body sometimes includes the full doc — check it directly
            const rawBody = request.body as Record<string, unknown>
            if (rawBody?.custom_sync_source === 'TALLYBRIDGE') {
                logger.debug({ name }, 'Webhook: skipping own-write (loop guard)')
                return reply.send({ ok: true, skipped: true, reason: 'own-write loop guard' })
            }

            const action: 'CREATE' | 'ALTER' | 'CANCEL' =
                event === 'on_cancel' ? 'CANCEL' :
                event === 'on_submit' ? 'CREATE' : 'ALTER'

            // Look up the company by ERPNext company name from the doc
            // We need the full doc to get company name + content
            // Find which DB company matches
            const companies = await sql<{
                id: string
                erpnext_url: string
                erpnext_api_key: string
                erpnext_api_secret: string
                erpnext_company: string
                machine_token_hash: string
            }[]>`
                SELECT c.id, c.erpnext_url, c.erpnext_api_key, c.erpnext_api_secret, c.erpnext_company,
                       c.machine_token_hash
                FROM companies c
                WHERE c.erpnext_company IS NOT NULL AND c.erpnext_company != ''
                  AND c.erpnext_url IS NOT NULL AND c.erpnext_url != ''
                  AND c.machine_id IS NOT NULL AND c.machine_id != ''
                ORDER BY c.created_at DESC
            `

            if (companies.length === 0) {
                logger.warn({ doctype, name }, 'Webhook: no companies with ERP config')
                return reply.send({ ok: true, skipped: true, reason: 'no erpnext companies configured' })
            }

            // Fetch the full document from ERPNext using first company's creds
            // (all companies typically share the same ERPNext instance)
            let fetchCompany = companies[0]!
            let erpClient = new ERPNextClient({
                baseUrl: fetchCompany.erpnext_url,
                apiKey: fetchCompany.erpnext_api_key,
                apiSecret: fetchCompany.erpnext_api_secret,
            })

            let fullDoc: Record<string, unknown>
            try {
                fullDoc = await erpClient.getDoc(doctype, name) as Record<string, unknown>
            } catch (err) {
                logger.error({ err, doctype, name }, 'Webhook: failed to fetch doc from ERPNext')
                return reply.code(500).send({ error: 'Failed to fetch doc from ERPNext' })
            }

            // Skip loop-back check on full doc
            if (fullDoc?.custom_sync_source === 'TALLYBRIDGE') {
                logger.debug({ name }, 'Webhook: full doc is own-write, skipping')
                return reply.send({ ok: true, skipped: true, reason: 'own-write loop guard' })
            }

            // Find the matching DB company by doc.company field
            const docCompany = (fullDoc.company as string) ?? ''
            const matchedCompany = companies.find(c =>
                c.erpnext_company.toLowerCase() === docCompany.toLowerCase()
            ) ?? fetchCompany

            // Re-create ERP client with matched company's creds if different
            if (matchedCompany.id !== fetchCompany.id) {
                erpClient = new ERPNextClient({
                    baseUrl: matchedCompany.erpnext_url,
                    apiKey: matchedCompany.erpnext_api_key,
                    apiSecret: matchedCompany.erpnext_api_secret,
                })
            }

            // Load the config_profile for this company
            const [profile] = await sql<{
                account_mappings: Record<string, string>
                gst_ledger_mappings: Record<string, string>
                voucher_type_mappings: Record<string, unknown>
                conflict_strategy: { default: string }
            }[]>`
                SELECT account_mappings, gst_ledger_mappings, voucher_type_mappings, conflict_strategy
                FROM config_profiles WHERE company_id = ${matchedCompany.id}
            `

            const config: CompanyConfig = {
                companyId: matchedCompany.id,
                erpnextCompany: matchedCompany.erpnext_company,
                currency: 'INR',
                accountMappings: profile?.account_mappings ?? {},
                gstLedgerMappings: {
                    output_cgst: profile?.gst_ledger_mappings?.output_cgst ?? '',
                    output_sgst: profile?.gst_ledger_mappings?.output_sgst ?? '',
                    output_igst: profile?.gst_ledger_mappings?.output_igst ?? '',
                    input_cgst:  profile?.gst_ledger_mappings?.input_cgst  ?? '',
                    input_sgst:  profile?.gst_ledger_mappings?.input_sgst  ?? '',
                    input_igst:  profile?.gst_ledger_mappings?.input_igst  ?? '',
                },
                voucherTypeMappings: (profile?.voucher_type_mappings ?? {}) as CompanyConfig['voucherTypeMappings'],
                conflictStrategy: (profile?.conflict_strategy as CompanyConfig['conflictStrategy']) ?? { default: 'TALLY_WINS' },
                syncDirection: {},
            }

            // Transform ERPNext doc → TallyVoucherInput
            let tallyPayload: Record<string, unknown>
            try {
                switch (doctype as SupportedDoctype) {
                    case 'Sales Invoice':
                        tallyPayload = erpSalesToTally(fullDoc as never, config, action) as unknown as Record<string, unknown>
                        break
                    case 'Purchase Invoice':
                        tallyPayload = erpPurchaseToTally(fullDoc as never, config, action) as unknown as Record<string, unknown>
                        break
                    case 'Payment Entry':
                        tallyPayload = erpPaymentToTally(fullDoc as never, config, action) as unknown as Record<string, unknown>
                        break
                    case 'Journal Entry':
                        tallyPayload = erpJournalToTally(fullDoc as never, config, action) as unknown as Record<string, unknown>
                        break
                }
            } catch (err) {
                logger.error({ err, doctype, name }, 'Webhook: transform failed')
                return reply.code(500).send({ error: 'Transform failed', detail: String(err) })
            }

            const tallyGuid = (fullDoc.custom_tally_guid as string) ?? `ERP-${name}`

            await enqueueTallyWrite({
                companyId: matchedCompany.id,
                action,
                voucherType: doctype,
                tallyGuid,
                payload: tallyPayload!,
            })

            logger.info({ companyId: matchedCompany.id, doctype, name, action }, 'Webhook: enqueued tally-write job')
            return reply.send({ ok: true, action, tallyGuid })
        }
    )
}
