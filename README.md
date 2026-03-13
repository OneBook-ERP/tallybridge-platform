# TallyBridge Platform

Cloud middleware that syncs data between **Tally ERP** and **ERPNext** in real-time. Receives voucher data from the [TallyBridge Connector](https://github.com/OneBook-ERP/tallybridge-connector) desktop app, transforms it, and writes to ERPNext via REST API.

## Architecture

```
Tally ERP (Desktop)
    ↕ XML API
TallyBridge Connector (Wails desktop app)
    ↕ REST API + WebSocket
TallyBridge Platform (this repo)  ← Fastify + BullMQ + PostgreSQL + Redis
    ↕ REST API
ERPNext (Cloud SaaS)
```

## Tech Stack

- **Runtime:** Node.js + TypeScript
- **API Server:** Fastify
- **Job Queue:** BullMQ (Redis-backed)
- **Database:** PostgreSQL 16
- **Real-time:** WebSocket (Fastify plugin)
- **Monorepo:** Turborepo with two apps (`cloud`, `cloud-frontend`)

## Project Structure

```
apps/
├── cloud/                    # Backend API + sync engine
│   └── src/
│       ├── api/              # REST endpoints (connector, dashboard)
│       ├── auth/             # Machine token auth
│       ├── db/               # PostgreSQL connection + migrations
│       ├── erpnext/          # ERPNext REST API client
│       ├── lib/              # Env, logger, errors
│       ├── queue/            # BullMQ producer/consumer
│       ├── realtime/         # WebSocket broadcaster
│       ├── sync/             # Sync engine, loop guard, conflict detection
│       └── transform/        # Tally → ERPNext transformers
│           ├── account-resolver.ts    # Ledger → Account mapping
│           ├── gst-resolver.ts        # GST tax computation
│           └── tally-to-erp/          # Per-doctype transformers
│               ├── sales.ts           # Sales Invoice
│               ├── purchase.ts        # Purchase Invoice
│               ├── payment.ts         # Payment Entry
│               └── journal.ts         # Journal Entry
├── cloud-frontend/           # React dashboard (Vite + Tailwind)
│   └── src/
│       ├── app/dashboard/    # Dashboard page (stats, sync records, exceptions, data comparison)
│       └── lib/api.ts        # API client
└── scripts/
    └── cleanup-duplicates.ts # ERPNext duplicate document cleanup
```

## Setup

### Prerequisites
- Node.js 20+
- Docker (for PostgreSQL + Redis)
- ERPNext instance with API access

### Development

```bash
# Start database and Redis
docker compose up -d

# Install dependencies
npm install

# Configure environment
cp apps/cloud/.env.example apps/cloud/.env
# Edit .env with your database and ERPNext credentials

# Run migrations
npm run migrate -w apps/cloud

# Start dev server (with hot reload)
npm run dev -w apps/cloud

# Start frontend
npm run dev -w apps/cloud-frontend
```

### Environment Variables

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | PostgreSQL connection string |
| `REDIS_URL` | Redis connection string |
| `JWT_SECRET` | Secret for machine token auth |
| `ERPNEXT_URL` | ERPNext instance URL |
| `ERPNEXT_API_KEY` | ERPNext API key |
| `ERPNEXT_API_SECRET` | ERPNext API secret |

## Sync Pipeline

1. **Connector** sends Tally vouchers to `POST /connector/sync-data`
2. **BullMQ** queues the batch as a `sync-jobs` job
3. **Sync Engine** processes each voucher:
   - Loop guard check (skip if we wrote it)
   - Conflict detection (hash comparison)
   - Transform (Tally → ERPNext format)
   - Auto-create masters (Customer, Supplier, Item)
   - Write to ERPNext (create or cancel-amend)
   - Update sync record + audit log

### Account Resolution Order

1. GST pattern match (CGST/SGST/IGST)
2. Round-off detection (auto-skip)
3. Exact match in `accountMappings`
4. Party fallback (Debtors/Creditors) via `isPartyLedger` flag or `partyLedgerName`
5. Aggressive party detection (name without expense keywords → assumed party)
6. Unmapped → TIER-3 exception

## API Endpoints

### Connector APIs (auth: Bearer machine token)
- `POST /connector/register` — Register connector + get machine token
- `POST /connector/heartbeat` — Connector health ping
- `POST /connector/sync-data` — Upload Tally voucher batch
- `GET /connector/jobs/pending` — Long-poll for reverse sync jobs

### Dashboard APIs
- `GET /dashboard/companies` — List registered companies
- `GET /dashboard/stats?companyId=` — Sync overview metrics
- `GET /dashboard/sync-records?companyId=` — Recent sync activity
- `GET /dashboard/exceptions?companyId=` — Open exceptions
- `GET /dashboard/audit-log?companyId=` — Audit trail
- `GET /dashboard/data-comparison?companyId=` — Tally vs ERPNext counts

---

## Task Tracker

### Completed
- [x] Fastify server with health endpoint
- [x] PostgreSQL schema + migrations (7 tables)
- [x] BullMQ job queue (sync-jobs + tally-write)
- [x] Machine token auth for connectors
- [x] Connector registration endpoint
- [x] Sync data ingestion endpoint (with 50MB body limit)
- [x] Full sync engine (transform → write → record)
- [x] Sales Invoice transformer (with GST, credit notes)
- [x] Purchase Invoice transformer (with debit notes)
- [x] Payment Entry transformer (with bill allocations)
- [x] Journal Entry transformer (with contra support)
- [x] Account resolver with 6-step resolution
- [x] GST resolver (inter/intra state, RCM, place of supply)
- [x] ERPNext REST client (CRUD, cancel-amend, count)
- [x] Auto-create Customer/Supplier/Item in ERPNext
- [x] Conflict detection (hash-based)
- [x] Loop guard (skip own writes)
- [x] Duplicate guard (check ERPNext before creating)
- [x] WebSocket broadcaster for real-time updates
- [x] Dashboard API (stats, sync records, exceptions, audit, data comparison)
- [x] Dashboard frontend (React + Tailwind)
- [x] Exception recording for ERPNext write failures
- [x] Company-agnostic transforms (config-driven)
- [x] Aggressive party detection for unmapped ledgers
- [x] `__IGNORE__` account handling (skip entries)

### In Progress
- [ ] Reverse sync (ERPNext → Tally via webhooks)
- [ ] Master data sync (ledgers, stock items from connector)

### To Do — High Priority
- [ ] Wire `/connector/heartbeat` (connector never calls it)
- [ ] Wire `/connector/jobs/pending` (long-poll for reverse sync)
- [ ] Opening balance sync (Tally → ERPNext)
- [ ] Address/contact sync for customers/suppliers
- [ ] HSN code passthrough from Tally stock items
- [ ] Retry mechanism for failed ERPNext writes
- [ ] Rate limiting and backpressure on sync ingestion

### To Do — Medium Priority
- [ ] Multi-company support (tested with single company so far)
- [ ] Dashboard: settings page for account mappings
- [ ] Dashboard: conflict resolution UI
- [ ] Dashboard: manual exception resolution
- [ ] ERPNext webhook receiver (for ERP → Tally sync)
- [ ] Batch processing optimization (parallel ERPNext writes)
- [ ] Company GSTIN in config_profiles (currently optional)

### To Do — Low Priority
- [ ] Authentication for dashboard (currently open)
- [ ] Pagination for dashboard API responses
- [ ] Export sync report (CSV/PDF)
- [ ] Email/Slack notifications for sync failures
- [ ] Metrics and monitoring (Prometheus)
- [ ] Unit tests for all transformers
- [ ] Integration tests with live ERPNext
- [ ] CI/CD pipeline
- [ ] Docker deployment config
- [ ] Documentation for onboarding new companies

---

## License

Private — OneBook ERP
