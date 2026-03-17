-- Migration 016: support multiple companies per machine
-- A single connector machine can switch between different Tally companies.
-- The old UNIQUE(machine_id) constraint forced one-company-per-machine.
-- Replace it with UNIQUE(machine_id, tally_company_name) so each
-- (machine, company) pair gets its own row and config.

-- Drop the old single-column unique index
DROP INDEX IF EXISTS idx_companies_machine_id;

-- Drop the existing unique index on tally_company_name alone
-- (too strict — two machines can share the same Tally company name)
DROP INDEX IF EXISTS idx_companies_tally_name;

-- New composite unique: same machine + same Tally company = one row
CREATE UNIQUE INDEX IF NOT EXISTS idx_companies_machine_company
    ON companies (machine_id, tally_company_name)
    WHERE machine_id IS NOT NULL;
