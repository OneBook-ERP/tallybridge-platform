-- Migration 017: one-time registration tokens
-- Admin generates a token via dashboard, embeds it in the connector cloud URL.
-- Connector sends it during POST /connector/register.
-- Cloud validates → creates company → inserts admin_company_access automatically.

CREATE TABLE IF NOT EXISTS registration_tokens (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    token       TEXT        NOT NULL UNIQUE,          -- random 24-char token shown to admin
    admin_id    UUID        NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
    expires_at  TIMESTAMPTZ NOT NULL DEFAULT (now() + INTERVAL '24 hours'),
    consumed_at TIMESTAMPTZ,                          -- set when connector uses it
    company_id  UUID        REFERENCES companies(id), -- set after consumption
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_reg_tokens_admin ON registration_tokens(admin_id);
CREATE INDEX IF NOT EXISTS idx_reg_tokens_token ON registration_tokens(token);
