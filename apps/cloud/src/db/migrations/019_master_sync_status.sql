-- Track ERPNext sync status for master data (ledgers + stock items)
ALTER TABLE ledger_masters
    ADD COLUMN IF NOT EXISTS sync_status  TEXT DEFAULT 'pending',    -- 'pending', 'synced', 'failed'
    ADD COLUMN IF NOT EXISTS erpnext_name TEXT,                       -- ERPNext doctype name after creation
    ADD COLUMN IF NOT EXISTS error_message TEXT;

ALTER TABLE stock_item_masters
    ADD COLUMN IF NOT EXISTS sync_status  TEXT DEFAULT 'pending',
    ADD COLUMN IF NOT EXISTS erpnext_name TEXT,
    ADD COLUMN IF NOT EXISTS error_message TEXT;

-- Index for quick failure lookups
CREATE INDEX IF NOT EXISTS idx_ledger_masters_sync_status ON ledger_masters(company_id, sync_status);
CREATE INDEX IF NOT EXISTS idx_stock_item_masters_sync_status ON stock_item_masters(company_id, sync_status);
