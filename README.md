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
- **Testing:** Vitest (166 tests)
- **Linting:** ESLint + Prettier

## Project Structure

```
apps/
├── cloud/                    # Backend API + sync engine
│   └── src/
│       ├── api/              # REST endpoints
│       │   ├── connector/    # Connector registration, sync-data, heartbeat
│       │   └── dashboard/    # Dashboard stats, exceptions, audit log
│       ├── auth/             # Machine token auth
│       ├── db/               # PostgreSQL connection + 8 migrations
│       ├── erpnext/          # ERPNext REST API client (retry, rate limiting)
│       ├── lib/              # Env, logger, crypto, errors
│       ├── queue/            # BullMQ producer/consumer
│       ├── realtime/         # WebSocket broadcaster
│       ├── sync/             # Sync engine, loop guard, conflict detection
│       ├── test/             # Test setup + fixtures
│       └── transform/        # Tally → ERPNext transformers
│           ├── normalize.ts          # PascalCase → camelCase normalizer
│           ├── account-resolver.ts   # 6-step ledger → account resolution
│           ├── gst-resolver.ts       # GST tax computation (CGST/SGST/IGST/RCM)
│           └── tally-to-erp/         # Per-doctype transformers
│               ├── sales.ts          # Sales Invoice + Credit Notes
│               ├── purchase.ts       # Purchase Invoice + Debit Notes
│               ├── payment.ts        # Payment Entry (Pay/Receive)
│               └── journal.ts        # Journal Entry + Contra
├── cloud-frontend/           # React dashboard (Vite + Tailwind CSS 4)
│   └── src/
│       ├── app/dashboard/    # 4-tab dashboard (Overview, Exceptions, Activity, Settings)
│       └── lib/api.ts        # API client + WebSocket hook
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

# Run migrations
npm run migrate -w apps/cloud

# Start dev server (with hot reload)
npm run dev -w apps/cloud

# Start frontend (port 5173, proxies /api to localhost:3000)
npm run dev -w apps/cloud-frontend
```

### Running Tests

```bash
# Run all 166 tests
npm test -w apps/cloud

# With coverage
npm test -w apps/cloud -- --coverage
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
| `JWT_SECRET` | Secret for machine token auth |
| `ERPNEXT_URL` | ERPNext instance URL |
| `ERPNEXT_API_KEY` | ERPNext API key |
| `ERPNEXT_API_SECRET` | ERPNext API secret |

## Sync Pipeline

1. **Connector** sends Tally vouchers to `POST /connector/sync-data`
2. **BullMQ** queues the batch as a `sync-jobs` job
3. **Sync Engine** processes each voucher:
   - Loop guard check (skip if we wrote it via `custom_sync_source`)
   - Conflict detection (hash comparison — skip unchanged)
   - Transform (Tally → ERPNext format with GST, dates, HSN)
   - Auto-create masters (Customer, Supplier, Item with GSTIN)
   - Write to ERPNext (create or cancel-amend)
   - Record sync result + audit log entry

### Deduplication (3-layer)
1. **Hash-based skip** — sync_records table stores content hash per GUID
2. **ERPNext duplicate guard** — `findByTallyGUID` checks before creating
3. **Redis loop guard** — prevents re-processing own writes

### Account Resolution (6-step)
1. GST pattern match (CGST/SGST/IGST → tax accounts)
2. Round-off detection (auto-skip small amounts)
3. Exact match in `accountMappings` config
4. Party fallback (Debtors/Creditors) via `isPartyLedger` flag
5. Aggressive party detection (name without expense keywords → party)
6. Unmapped → TIER-3 exception

### Exception Handling (3-tier)
- **Tier 1** — Auto-corrected (rounding, missing HSN → fallback SAC `999111`)
- **Tier 2** — Flagged (ERPNext write failures, config issues)
- **Tier 3** — Blocked (unmapped ledgers, transform failures)

## API Endpoints

### Connector APIs (auth: Bearer machine token)
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/connector/register` | Register connector, get machine token |
| POST | `/connector/heartbeat` | Connector keep-alive ping |
| POST | `/connector/sync-data` | Upload Tally voucher/master batch |
| GET | `/connector/jobs/pending` | Long-poll for reverse sync jobs |
| POST | `/connector/jobs/result` | Report reverse sync job result |

### Dashboard APIs
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/dashboard/companies` | List registered companies |
| GET | `/dashboard/stats` | Sync overview (synced, errored, pending, exceptions) |
| GET | `/dashboard/sync-records` | Recent sync activity with pagination |
| GET | `/dashboard/exceptions` | Open exceptions with error details |
| GET | `/dashboard/audit-log` | Full audit trail |
| GET | `/dashboard/data-comparison` | Tally vs ERPNext document counts |

### Webhook
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/webhook/erpnext` | ERPNext webhook receiver (reverse sync) |

## Test Coverage

| Test File | Tests | Description |
|-----------|-------|-------------|
| `utils.test.ts` | 29 | Date parsing, amount rounding, sanitization |
| `account-resolver.test.ts` | 18 | 6-step resolution, party detection, GST |
| `gst-resolver.test.ts` | 11 | Inter/intra state, RCM, categories |
| `normalize.test.ts` | 8 | PascalCase → camelCase conversion |
| `crypto.test.ts` | 15 | Hashing, token generation |
| `sales.test.ts` | 16 | Sales invoices, credit notes, returns |
| `purchase.test.ts` | 8 | Purchase invoices, debit notes |
| `payment.test.ts` | 9 | Payments, receipts, bill allocations |
| `journal.test.ts` | 11 | Journals, contra, rounding balance |
| `index.test.ts` | 10 | Voucher type routing |
| `client.test.ts` | 31 | ERPNext API client, retry, master creation |

---

## License

Private — OneBook ERP
