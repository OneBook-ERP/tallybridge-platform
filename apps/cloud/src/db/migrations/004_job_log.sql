-- Migration 004: job_log
-- Append-only audit of every sync job attempted. Never updated — new rows only.

CREATE TABLE IF NOT EXISTS job_log (
    id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id      UUID         NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    job_type        TEXT         NOT NULL,    -- TRANSFORM | WRITE_TALLY | WRITE_ERP | HEARTBEAT
    source_doctype  TEXT,
    source_name     TEXT,
    direction       TEXT         CHECK (direction IN ('TALLY_TO_ERP','ERP_TO_TALLY')),
    status          TEXT         NOT NULL DEFAULT 'PENDING'
                      CHECK (status IN ('PENDING','RUNNING','SUCCESS','ERROR','SKIPPED')),
    error_message   TEXT,
    payload         JSONB,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
    completed_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_job_log_company_status
    ON job_log (company_id, status, created_at DESC);
