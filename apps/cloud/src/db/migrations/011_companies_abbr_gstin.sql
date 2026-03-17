-- Migration 011: add erpnext_abbr and erpnext_gstin to companies
-- erpnext_abbr: company abbreviation used as suffix in ERPNext account names (e.g. "CPT")
-- erpnext_gstin: company GSTIN used for inter-state GST detection

ALTER TABLE companies
    ADD COLUMN IF NOT EXISTS erpnext_abbr  TEXT,
    ADD COLUMN IF NOT EXISTS erpnext_gstin TEXT;
