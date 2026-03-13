-- Migration 006: exception_register
-- Three-tier exception model from PRD:
--   TIER1_AUTO  — auto-resolved, logged only
--   TIER2_FLAG  — flagged for review, sync continues
--   TIER3_BLOCK — sync blocked until resolved

CREATE TABLE IF NOT EXISTS exception_register (
    id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id    UUID         NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    tier          TEXT         NOT NULL
                    CHECK (tier IN ('TIER1_AUTO','TIER2_FLAG','TIER3_BLOCK')),
    document_ref  TEXT,        -- e.g. "Voucher:GUID" or "Ledger:party-name"
    error_code    TEXT         NOT NULL,
    error_message TEXT         NOT NULL,
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
    resolved_at   TIMESTAMPTZ,
    resolved_by   TEXT
);

CREATE INDEX IF NOT EXISTS idx_exceptions_company_open
    ON exception_register (company_id, tier, created_at DESC)
    WHERE resolved_at IS NULL;
