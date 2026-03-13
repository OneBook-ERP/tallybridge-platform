-- Migration 008: add erpnext_company column and machine_id for dedup
-- erpnext_company: the exact ERPNext company name (may differ from tally_company_name casing/suffix)
-- machine_id: stable connector machine identifier used for upsert-based registration

ALTER TABLE companies
    ADD COLUMN IF NOT EXISTS erpnext_company TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS machine_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_companies_machine_id
    ON companies (machine_id)
    WHERE machine_id IS NOT NULL;
