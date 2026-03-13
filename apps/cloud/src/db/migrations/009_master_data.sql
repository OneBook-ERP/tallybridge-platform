-- Master data tables for Tally ledgers and stock items
-- These store the hierarchical data that Tally provides, enabling
-- auto-generation of account mappings and lookup during transform.

CREATE TABLE IF NOT EXISTS ledger_masters (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id      UUID NOT NULL REFERENCES companies(id),
    tally_name      TEXT NOT NULL,
    tally_parent     TEXT,                   -- parent group in Tally hierarchy
    tally_group     TEXT,                    -- Tally group classification
    opening_balance NUMERIC(18,2) DEFAULT 0,
    gstin           TEXT,
    is_party_ledger BOOLEAN DEFAULT FALSE,
    ledger_type     TEXT,                    -- 'Customer', 'Supplier', 'Bank', 'Expense', etc.
    raw_data        JSONB,                   -- full Tally ledger object for reference
    synced_at       TIMESTAMPTZ DEFAULT now(),
    CONSTRAINT uq_ledger_company_name UNIQUE (company_id, tally_name)
);

CREATE TABLE IF NOT EXISTS stock_item_masters (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id      UUID NOT NULL REFERENCES companies(id),
    tally_name      TEXT NOT NULL,
    tally_parent     TEXT,                   -- parent stock group
    uom             TEXT,                    -- unit of measure
    hsn_code        TEXT,
    opening_qty     NUMERIC(18,3) DEFAULT 0,
    opening_value   NUMERIC(18,2) DEFAULT 0,
    raw_data        JSONB,
    synced_at       TIMESTAMPTZ DEFAULT now(),
    CONSTRAINT uq_stock_item_company_name UNIQUE (company_id, tally_name)
);

CREATE INDEX IF NOT EXISTS idx_ledger_masters_company ON ledger_masters(company_id);
CREATE INDEX IF NOT EXISTS idx_stock_items_company ON stock_item_masters(company_id);
