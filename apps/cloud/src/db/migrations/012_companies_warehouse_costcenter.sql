-- Migration 012: add erpnext_warehouse and erpnext_cost_center to companies
-- These are per-company defaults used for Stock Reconciliation and Journal Entries.
ALTER TABLE companies
    ADD COLUMN IF NOT EXISTS erpnext_warehouse   TEXT,
    ADD COLUMN IF NOT EXISTS erpnext_cost_center TEXT;
