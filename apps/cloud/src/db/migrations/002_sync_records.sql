-- Migration 002: sync_records
-- One row per (company, tally_guid). Tracks the mapping between
-- a Tally GUID and an ERPNext document name, plus both-side hashes
-- for conflict detection.

CREATE TABLE IF NOT EXISTS sync_records (
    id               UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id       UUID         NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    tally_guid       TEXT         NOT NULL,
    erpnext_doctype  TEXT,
    erpnext_name     TEXT,
    tally_hash       TEXT,        -- SHA-256 of the Tally side payload
    erpnext_hash     TEXT,        -- SHA-256 of the ERPNext side payload
    last_synced_at   TIMESTAMPTZ,
    direction        TEXT         NOT NULL DEFAULT 'TALLY_TO_ERP'
                       CHECK (direction IN ('TALLY_TO_ERP','ERP_TO_TALLY','BOTH')),
    sync_status      TEXT         NOT NULL DEFAULT 'PENDING'
                       CHECK (sync_status IN ('SYNCED','PENDING','ERROR','CONFLICT')),

    CONSTRAINT uq_company_guid UNIQUE (company_id, tally_guid)
);

CREATE INDEX IF NOT EXISTS idx_sync_records_company_status
    ON sync_records (company_id, sync_status);

CREATE INDEX IF NOT EXISTS idx_sync_records_erpnext_name
    ON sync_records (company_id, erpnext_doctype, erpnext_name);
