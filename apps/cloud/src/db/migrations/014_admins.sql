-- Admin users for dashboard access + multi-tenancy scoping
CREATE TABLE IF NOT EXISTS admins (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    email           TEXT        NOT NULL UNIQUE,
    password_hash   TEXT        NOT NULL,
    display_name    TEXT,
    role            TEXT        NOT NULL DEFAULT 'company_admin'
                      CHECK (role IN ('superadmin', 'company_admin')),
    is_active       BOOLEAN     NOT NULL DEFAULT true,
    last_login_at   TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS admin_company_access (
    id          UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
    admin_id    UUID    NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
    company_id  UUID    NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(admin_id, company_id)
);

CREATE INDEX IF NOT EXISTS idx_admin_company_access_admin ON admin_company_access(admin_id);
CREATE INDEX IF NOT EXISTS idx_admin_company_access_company ON admin_company_access(company_id);
