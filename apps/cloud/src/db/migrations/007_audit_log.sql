-- Migration 007: audit_log
-- APPEND ONLY — never UPDATE or DELETE rows.
-- All system and user actions are recorded here for compliance.

CREATE TABLE IF NOT EXISTS audit_log (
    id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id      UUID         REFERENCES companies(id) ON DELETE SET NULL,
    actor           TEXT         NOT NULL,  -- 'system' | user_id
    event_type      TEXT         NOT NULL,  -- e.g. 'sync.created', 'conflict.resolved', 'rule.changed'
    document_ref    TEXT,
    payload_before  JSONB,
    payload_after   JSONB,
    timestamp       TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- Partial index for company-scoped audit trail queries (most common access pattern).
CREATE INDEX IF NOT EXISTS idx_audit_log_company_time
    ON audit_log (company_id, timestamp DESC)
    WHERE company_id IS NOT NULL;

-- Prevent accidental deletes/updates at DB level.
-- The trigger raises an error if anyone tries to UPDATE or DELETE.
CREATE OR REPLACE FUNCTION audit_log_immutable() RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'audit_log is append-only — updates and deletes are not permitted';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_audit_log_immutable ON audit_log;
CREATE TRIGGER trg_audit_log_immutable
    BEFORE UPDATE OR DELETE ON audit_log
    FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();
