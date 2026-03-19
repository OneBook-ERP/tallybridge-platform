# TallyBridge Platform

Cloud middleware that syncs data between **Tally ERP** and **ERPNext** in real-time. Receives voucher data from the [TallyBridge Connector](https://github.com/OneBook-ERP/tallybridge-connector) desktop app, transforms it, and writes to ERPNext via REST API.

[![CI](https://github.com/OneBook-ERP/tallybridge-platform/actions/workflows/ci.yml/badge.svg)](https://github.com/OneBook-ERP/tallybridge-platform/actions/workflows/ci.yml)

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

- **Runtime:** Node.js 20 + TypeScript
- **API Server:** Fastify
- **Job Queue:** BullMQ (Redis-backed)
- **Database:** PostgreSQL 16
- **Real-time:** WebSocket (Fastify plugin)
- **Monorepo:** Turborepo with two apps (`cloud`, `cloud-frontend`)
- **Testing:** Vitest (507 tests across 32 files)
- **Linting:** ESLint + Prettier

## Project Structure

```
apps/
├── cloud/                    # Backend API + sync engine
│   └── src/
│       ├── api/              # REST endpoints
│       │   ├── connector/    # Registration, sync-data, heartbeat, jobs, config
│       │   ├── dashboard/    # Companies, stats, exceptions, audit, data-comparison
│       │   └── webhook/      # ERPNext webhook receiver (reverse sync)
│       ├── auth/             # Machine token + JWT admin auth
│       ├── db/               # PostgreSQL connection + 14 migrations
│       ├── erpnext/          # ERPNext REST client (retry, rate limiting, masters)
│       ├── lib/              # Env, logger, crypto, errors
│       ├── queue/            # BullMQ producer + consumer (master data + vouchers)
│       ├── realtime/         # WebSocket broadcaster
│       ├── sync/             # Sync engine, loop guard, conflict detection
│       ├── test/             # Test setup + fixtures (Covai Polymer Traders data)
│       └── transform/        # Bidirectional transformers
│           ├── normalize.ts          # PascalCase → camelCase normalizer
│           ├── account-resolver.ts   # 6-step ledger → account resolution
│           ├── gst-resolver.ts       # GST tax computation (CGST/SGST/IGST/RCM)
│           ├── tally-to-erp/         # Tally → ERPNext (sales, purchase, payment, journal)
│           └── erp-to-tally/         # ERPNext → Tally (reverse sync transforms)
├── cloud-frontend/           # React dashboard (Vite + Tailwind CSS 4)
│   └── src/
│       ├── app/dashboard/    # Multi-tab dashboard with real-time WebSocket updates
│       │   ├── page.tsx      # Overview, Exceptions, Activity Log, Config, Settings
│       │   ├── admin-manager.tsx  # Admin user management
│       │   └── setup-wizard.tsx   # Initial setup flow
│       └── lib/              # API client, auth, WebSocket hook
├── scripts/
│   ├── setup-erpnext-custom-fields.sh  # ERPNext custom field setup
│   └── cleanup-duplicates.ts           # Duplicate document cleanup
└── docker-compose.yml        # PostgreSQL + Redis
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

# Run migrations (auto-runs on startup)
npm run dev -w apps/cloud

# Start backend (port 3000)
npm run dev -w apps/cloud

# Start frontend (port 5173, proxies API to localhost:3000)
npm run dev -w apps/cloud-frontend
```

### Running Tests

```bash
# Run all 507 tests
cd apps/cloud && npm test

# With coverage
npm test -- --coverage
```

### Linting

```bash
npm run lint           # ESLint check
npm run format:check   # Prettier check
npm run lint:fix       # Auto-fix lint issues
npm run format         # Auto-format
```

### Environment Variables

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | PostgreSQL connection string |
| `REDIS_URL` | Redis connection string |
| `JWT_SECRET` | Secret for admin JWT auth |
| `MACHINE_TOKEN_SECRET` | Secret for connector machine tokens |

## Sync Pipeline

### Tally to ERPNext
1. **Connector** sends Tally vouchers/masters to `POST /connector/sync-data`
2. **BullMQ** queues the batch as a `sync-jobs` job (masters prioritized)
3. **Consumer** processes masters first:
   - Classifies ledgers via group ancestry walk (Customer, Supplier, Bank, etc.)
   - Creates Customer/Supplier groups, parties, addresses, contacts in ERPNext
   - Stores in `ledger_masters` / `stock_item_masters` tables
4. **Sync Engine** processes each voucher:
   - Loop guard check (skip if written via `custom_sync_source`)
   - Hash-based dedup (skip unchanged vouchers)
   - Transform (Tally → ERPNext with GST, dates, HSN, multi-currency)
   - Auto-create missing masters (Customer, Supplier, Item, UOM, Item Group)
   - Write to ERPNext (create or cancel-amend)
   - Record sync result + audit log + broadcast via WebSocket

### ERPNext to Tally (Reverse Sync)
1. **ERPNext webhook** fires on submit/cancel/amend
2. **Platform** transforms ERPNext doc → Tally XML voucher format
3. **Job** queued for the connector to pick up via long-poll
4. **Connector** writes XML to Tally import API

### Deduplication (3-layer)
1. **Hash-based skip** — sync_records stores content hash per GUID
2. **ERPNext duplicate guard** — `findByTallyGUID` checks before creating
3. **Redis loop guard** — prevents re-processing own webhook writes

### Account Resolution (6-step)
1. GST pattern match (CGST/SGST/IGST → tax accounts)
2. Round-off detection (auto-skip small amounts)
3. Exact match in `accountMappings` config
4. Party fallback (Debtors/Creditors) via `isPartyLedger` flag
5. Aggressive party detection (name without expense keywords → party)
6. Unmapped → TIER-3 exception

### Exception Handling (3-tier)
- **Tier 1** — Auto-corrected (rounding, missing HSN → fallback SAC `999111`)
- **Tier 2** — Flagged (ERPNext write failures, master creation failures)
- **Tier 3** — Blocked (unmapped ledgers, missing GSTIN, transform failures)

## API Endpoints

### Connector APIs (auth: Bearer machine token)
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/connector/register` | Register connector, get machine token |
| POST | `/connector/heartbeat` | Connector status + Tally counts |
| POST | `/connector/sync-data` | Upload Tally voucher/master batch |
| PUT | `/connector/config` | Push account/GST/voucher mappings |
| GET | `/connector/jobs/pending` | Long-poll for reverse sync jobs |
| POST | `/connector/jobs/result` | Report reverse sync job result |
| GET | `/connector/exceptions` | Exceptions for connector's company |
| GET | `/connector/sync-records` | Sync records for connector's company |

### Dashboard APIs (auth: JWT admin token)
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/dashboard/companies` | List registered companies |
| GET | `/dashboard/stats` | Sync overview (synced, errored, pending, exceptions) |
| GET | `/dashboard/sync-records` | Paginated sync activity with total count |
| GET | `/dashboard/exceptions` | Paginated exceptions with filter by code |
| GET | `/dashboard/audit-log` | Full audit trail |
| GET | `/dashboard/data-comparison` | Tally vs Cloud vs ERPNext document counts |
| GET | `/dashboard/config` | Company config profile + mappings |
| PATCH | `/dashboard/config` | Update account/GST/voucher/godown mappings |
| GET | `/dashboard/godowns` | Godown to warehouse mapping list |
| POST | `/dashboard/reset-sync` | Clear sync history (optional: include masters) |
| DELETE | `/dashboard/company` | Permanently delete company + all data |
| POST | `/dashboard/reprocess-exceptions` | Retry failed exceptions |
| POST | `/dashboard/opening-balance` | Create opening balance journal entry |
| POST | `/dashboard/opening-stock` | Create stock reconciliation |

### Webhook
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/webhook/erpnext` | ERPNext webhook receiver (on_submit/cancel/amend) |

## Test Coverage (507 tests)

| Area | Files | Tests | Description |
|------|-------|-------|-------------|
| Utils & Core | 4 | 61 | Date parsing, hashing, normalization, crypto |
| Account & GST | 2 | 29 | 6-step resolution, GST categories, inter-state |
| Tally→ERP Transforms | 5 | 88 | Sales, purchase, payment, journal, routing |
| ERP→Tally Transforms | 4 | 32 | Reverse sync transforms |
| ERPNext Client | 2 | 74 | API client, retry, master creation (43 master tests) |
| Sync Engine | 3 | 45 | Engine pipeline, conflict detection, loop guard |
| Queue Consumer | 1 | 20 | Master processing, ledger classification, sorting |
| API Connector | 6 | 46 | Register, heartbeat, config, sync-data, result, jobs |
| API Dashboard | 1 | 28 | All dashboard routes |
| API Webhook | 1 | 13 | ERPNext webhook handling |
| Opening Balance | 1 | 10 | Opening balance journal entry |

---

## License

Private — OneBook ERP
