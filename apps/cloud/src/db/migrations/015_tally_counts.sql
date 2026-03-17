-- Migration 015: add tally_counts to companies for Tally-side record counts sent via heartbeat
ALTER TABLE companies
    ADD COLUMN IF NOT EXISTS tally_counts JSONB;

-- Also allow erpnext_warehouse to be NULL in godown_warehouse_mapping so discovered
-- godowns can be stored before a warehouse mapping is assigned.
ALTER TABLE godown_warehouse_mapping
    ALTER COLUMN erpnext_warehouse DROP NOT NULL;
