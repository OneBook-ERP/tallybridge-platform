-- Migration 005: conflict_log
-- When both Tally and ERPNext have modified the same record since last sync,
-- a conflict is recorded here for human review.

CREATE TABLE IF NOT EXISTS conflict_log (
    id                UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id        UUID         NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    tally_guid        TEXT         NOT NULL,
    tally_snapshot    JSONB        NOT NULL,
    erpnext_snapshot  JSONB        NOT NULL,
    detected_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
    resolved_at       TIMESTAMPTZ,
    resolution        TEXT         CHECK (resolution IN ('USE_TALLY','USE_ERPNEXT','MANUAL','SKIPPED')),
    resolved_by       TEXT         -- 'system' or user id
);

CREATE INDEX IF NOT EXISTS idx_conflict_log_company_open
    ON conflict_log (company_id, detected_at DESC)
    WHERE resolved_at IS NULL;
