-- Migration 010: add tally_voucher_number to sync_records
-- Used for payment-to-invoice reference resolution (bill-wise FIFO lookup).

ALTER TABLE sync_records
    ADD COLUMN IF NOT EXISTS tally_voucher_number TEXT;

CREATE INDEX IF NOT EXISTS idx_sync_records_voucher_number
    ON sync_records (company_id, erpnext_doctype, tally_voucher_number);
