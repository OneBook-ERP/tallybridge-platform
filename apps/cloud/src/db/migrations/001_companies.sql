-- Migration 001: companies
-- All timestamps are TIMESTAMPTZ (UTC always).

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS companies (
    id                   UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    tally_company_name   TEXT         NOT NULL,
    erpnext_url          TEXT,
    erpnext_api_key      TEXT,        -- encrypted via AES-256-GCM at app layer
    erpnext_api_secret   TEXT,        -- encrypted
    machine_token_hash   TEXT,        -- SHA-256 of the bearer token issued to connector
    created_at           TIMESTAMPTZ  NOT NULL DEFAULT now(),
    last_heartbeat_at    TIMESTAMPTZ,
    connector_status     TEXT         NOT NULL DEFAULT 'UNKNOWN'
                           CHECK (connector_status IN ('ONLINE','OFFLINE','UNKNOWN')),
    tally_status         TEXT         NOT NULL DEFAULT 'UNKNOWN'
                           CHECK (tally_status IN ('ONLINE','OFFLINE','UNKNOWN')),
    tally_version        TEXT
);

CREATE INDEX IF NOT EXISTS idx_companies_machine_token
    ON companies (machine_token_hash)
    WHERE machine_token_hash IS NOT NULL;
