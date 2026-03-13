-- Migration 003: config_profiles
-- One row per company. All mapping config is stored as JSONB so it can
-- evolve without schema migrations.

CREATE TABLE IF NOT EXISTS config_profiles (
    company_id                UUID  PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
    account_mappings          JSONB NOT NULL DEFAULT '{}',
    gst_ledger_mappings       JSONB NOT NULL DEFAULT '{}',
    voucher_type_mappings     JSONB NOT NULL DEFAULT '{}',
    party_group_mappings      JSONB NOT NULL DEFAULT '{}',
    item_group_mappings       JSONB NOT NULL DEFAULT '{}',
    uom_mappings              JSONB NOT NULL DEFAULT '{}',
    sync_direction_rules      JSONB NOT NULL DEFAULT '{}',
    conflict_strategy         JSONB NOT NULL DEFAULT '{"default":"MANUAL"}',
    historical_import_config  JSONB NOT NULL DEFAULT '{}',
    updated_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);
