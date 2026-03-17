-- Godown ↔ Warehouse mapping and custom Voucher Type mapping tables
-- Allows per-company override of Tally godown names → ERPNext warehouse names,
-- and custom Tally voucher type → ERPNext doctype routing.

CREATE TABLE IF NOT EXISTS godown_warehouse_mapping (
    company_id          UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    tally_godown        TEXT NOT NULL,
    erpnext_warehouse   TEXT NOT NULL,
    PRIMARY KEY (company_id, tally_godown)
);

CREATE TABLE IF NOT EXISTS voucher_type_mapping (
    company_id              UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    tally_voucher_type      TEXT NOT NULL,
    erpnext_doctype         TEXT NOT NULL,  -- 'Sales Invoice', 'Purchase Invoice', 'Journal Entry', 'Stock Entry'
    PRIMARY KEY (company_id, tally_voucher_type)
);

CREATE INDEX IF NOT EXISTS idx_godown_warehouse_company ON godown_warehouse_mapping(company_id);
CREATE INDEX IF NOT EXISTS idx_voucher_type_mapping_company ON voucher_type_mapping(company_id);
