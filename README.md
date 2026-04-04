# SwiftPay + NexusFlow

AI-powered payout processing with real-time collaboration, workflow automation, and WebSocket updates.

## What it does

- User auth with PASETO v4 tokens (register, email verification, login, OTP password reset, profile update)
- Payout initiation with distributed locking to prevent double-spend
- Multi-currency wallet (credit, debit, balance per currency)
- Transaction history and CSV/JSON export
- Spending limits (daily/weekly/monthly caps per user)
- Scheduled payouts with a background scheduler
- Webhooks — register endpoints, view delivery history, send test events
- AI fraud scoring via Groq (optional, blocks transactions above configurable threshold)
- Multi-agent AI system — risk assessment, fraud investigation, financial coaching
- Background AI anomaly detection on completed transactions
- IP geolocation and currency validation (optional)
- Real-time payout and chat events via Socket.IO
- Async payout processing via RabbitMQ payout worker
- Async workflow execution via RabbitMQ workflow worker
- Redis for sessions, rate limiting, balance cache, distributed locks, and pub/sub
- NexusFlow — workspaces, channels (with threads, reactions, pins, search), direct messages, workflow automation, notifications
- Workflow nodes: `ai_agent`, `send_message`, `send_email`, `http_request`, `condition`, `delay`
- AI providers in workflows: Groq, NVIDIA NIM, OpenRouter (25+ free models)
- Admin dashboard — user management, transaction oversight, audit logs, reports

## Stack

Node.js · Express · MongoDB · Redis · RabbitMQ · Socket.IO · PASETO v4 · Groq · NVIDIA NIM · OpenRouter · Winston · Zod

---

## Getting started

### 1. Install dependencies

```bash
npm install
```

### 2. Set up environment variables

```bash
cp .env.example .env
```

Edit `.env`. At minimum you need:

- `MONGO_URI`
- `REDIS_HOST` / `REDIS_PASSWORD`
- `RABBITMQ_URL`
- `PASETO_ACCESS_PRIVATE` / `PASETO_ACCESS_PUBLIC` (and refresh + verify pairs)
- `MAIL_USER`, `MAIL_PASS`

Generate PASETO key pairs (run once):

```bash
node scripts/generate-keys.js
```

Paste the output into your `.env`. Never commit private keys.

### 3. Start infrastructure (Docker)

```bash
docker-compose up mongodb redis rabbitmq -d
```

### 4. Run the API server

```bash
npm run dev
```

### 5. Run the payout worker (separate terminal)

```bash
npm run worker
```

### 6. Run the workflow worker (separate terminal)

```bash
npm run worker:workflow
```

---

## Docker (full stack)

```bash
docker-compose up --build
```

Starts MongoDB, Redis, RabbitMQ, the API gateway, the payout worker, and the workflow worker.

The RabbitMQ management UI is available at `http://localhost:15672`.

---

## API routes

### Auth
| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/auth/register` | Register a new user |
| GET | `/api/auth/verify-email` | Verify email (Bearer token) |
| POST | `/api/auth/resend-verification` | Resend verification email |
| POST | `/api/auth/login` | Login |
| POST | `/api/auth/logout` | Logout (requires auth) |
| POST | `/api/auth/refresh-token` | Get a new access token |
| GET | `/api/auth/profile` | Get current user (requires auth) |
| PUT | `/api/auth/profile` | Update profile (requires auth) |
| POST | `/api/auth/forgot-password` | Send OTP to email |
| POST | `/api/auth/verify-otp/:email` | Verify OTP |
| POST | `/api/auth/change-password/:email` | Change password |

### Payout
| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/payout/user` | Create a payout user profile |
| GET | `/api/payout/user/:userId` | Get a payout user profile |
| PUT | `/api/payout/user/:userId` | Update a payout user profile |
| DELETE | `/api/payout/user/:userId` | Delete a payout user profile |
| GET | `/api/payout/user/:userId/balance` | Get user balance |
| GET | `/api/payout/user/:userId/wallet` | Get all multi-currency wallet balances |
| POST | `/api/payout/user/:userId/wallet/credit` | Credit a currency wallet |
| POST | `/api/payout/user/:userId/wallet/debit` | Debit a currency wallet |
| GET | `/api/payout/user/:userId/history` | Get transaction history |
| GET | `/api/payout/user/:userId/export` | Export transactions (CSV or JSON) |
| POST | `/api/payout` | Initiate a payout |
| GET | `/api/payout/:transactionId` | Get transaction status |

### Scheduled Payouts
| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/scheduled-payouts` | Create a scheduled payout |
| GET | `/api/scheduled-payouts` | List scheduled payouts |
| GET | `/api/scheduled-payouts/:id` | Get a scheduled payout |
| PATCH | `/api/scheduled-payouts/:id` | Update a scheduled payout |
| DELETE | `/api/scheduled-payouts/:id` | Cancel a scheduled payout |

### Spending Limits
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/spending-limits` | List your spending limits |
| GET | `/api/spending-limits/usage` | Get current usage against limits |
| POST | `/api/spending-limits` | Set a spending limit |
| DELETE | `/api/spending-limits/:period` | Remove a spending limit |

### Webhooks
| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/webhooks` | Register a webhook |
| GET | `/api/webhooks` | List your webhooks |
| PATCH | `/api/webhooks/:id` | Update a webhook |
| DELETE | `/api/webhooks/:id` | Delete a webhook |
| GET | `/api/webhooks/:id/deliveries` | View delivery history |
| POST | `/api/webhooks/:id/test` | Send a test event |

### Workspaces
| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/workspaces` | Create a workspace |
| GET | `/api/workspaces` | List your workspaces |
| GET | `/api/workspaces/:id` | Get a workspace |
| PUT | `/api/workspaces/:id` | Update a workspace |
| DELETE | `/api/workspaces/:id` | Delete a workspace |
| POST | `/api/workspaces/:id/invite` | Invite a member |
| GET | `/api/workspaces/:id/members` | List members |
| PATCH | `/api/workspaces/:id/members/:userId/role` | Change member role |
| DELETE | `/api/workspaces/:id/members/:userId` | Remove a member |
| GET | `/api/workspaces/:id/stats` | Workspace stats |

### Channels
All routes are nested under `/api/workspaces/:workspaceId/channels`.

| Method | Path | Description |
|--------|------|-------------|
| POST | `/` | Create a channel |
| GET | `/` | List channels |
| GET | `/:channelId` | Get a channel |
| PUT | `/:channelId` | Update a channel |
| DELETE | `/:channelId` | Delete a channel |
| POST | `/:channelId/join` | Join a channel |
| POST | `/:channelId/leave` | Leave a channel |
| POST | `/:channelId/pin/:messageId` | Pin a message |
| DELETE | `/:channelId/pin/:messageId` | Unpin a message |
| GET | `/:channelId/search` | Search messages |
| POST | `/:channelId/messages` | Send a message |
| GET | `/:channelId/messages` | List messages |
| GET | `/:channelId/messages/:messageId` | Get a message |
| PUT | `/:channelId/messages/:messageId` | Edit a message |
| DELETE | `/:channelId/messages/:messageId` | Delete a message |
| POST | `/:channelId/messages/:messageId/react` | Add a reaction |
| DELETE | `/:channelId/messages/:messageId/react` | Remove a reaction |
| POST | `/:channelId/messages/:messageId/thread` | Reply in thread |
| GET | `/:channelId/messages/:messageId/thread` | Get thread replies |

### Direct Messages
All routes are nested under `/api/workspaces/:workspaceId/dms`.

| Method | Path | Description |
|--------|------|-------------|
| POST | `/` | Start a DM |
| GET | `/` | List DMs |
| GET | `/:dmId` | Get a DM |
| DELETE | `/:dmId` | Close a DM |
| GET | `/:dmId/members` | Get DM members |
| POST | `/:dmId/messages` | Send a message |
| GET | `/:dmId/messages` | Get messages |

### Workflows
All routes are nested under `/api/workspaces/:workspaceId/workflows`.

| Method | Path | Description |
|--------|------|-------------|
| POST | `/` | Create a workflow |
| GET | `/` | List workflows |
| GET | `/:workflowId` | Get a workflow |
| PUT | `/:workflowId` | Update a workflow |
| DELETE | `/:workflowId` | Delete a workflow |
| POST | `/:workflowId/enable` | Enable a workflow |
| POST | `/:workflowId/disable` | Disable a workflow |
| POST | `/:workflowId/trigger` | Manually trigger a workflow |
| GET | `/:workflowId/executions` | List execution history |
| GET | `/:workflowId/executions/:executionId` | Get an execution |
| POST | `/:workflowId/executions/:executionId/retry` | Retry an execution |

### Notifications
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/notifications` | List notifications |
| POST | `/api/notifications/mark-read` | Mark notifications as read |
| DELETE | `/api/notifications/:id` | Delete a notification |
| GET | `/api/notifications/preferences/:workspaceId` | Get notification preferences |
| PUT | `/api/notifications/preferences/:workspaceId` | Update notification preferences |

### Admin
All routes require authentication and admin role.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/admin/stats` | System overview |
| GET | `/api/admin/transactions` | All transactions |
| GET | `/api/admin/users` | All users |
| GET | `/api/admin/users/:userId` | User detail |
| GET | `/api/admin/users/:userId/transactions` | User transactions |
| PATCH | `/api/admin/users/:userId/status` | Update user status |
| POST | `/api/admin/users/:userId/balance` | Adjust user balance |
| POST | `/api/admin/users/:userId/spending-limits` | Set spending limit for user |
| DELETE | `/api/admin/users/:userId/spending-limits/:period` | Remove spending limit |
| GET | `/api/admin/scheduled-payouts` | All scheduled payouts |
| GET | `/api/admin/webhooks` | All webhooks |
| GET | `/api/admin/audit-logs` | Audit log |
| GET | `/api/admin/reports/volume` | Volume report |
| GET | `/api/admin/reports/currency` | Currency breakdown |
| GET | `/api/admin/reports/fraud` | Fraud report |

### AI / Validation
| Method | Path | Description | Auth |
|--------|------|-------------|------|
| GET | `/api/ai/usage` | API usage counters | None |
| GET | `/api/ai/currencies` | Supported currencies | None |
| GET | `/api/ai/validate/currency?currency=EUR&amount=100` | Validate currency + exchange rate | None |
| GET | `/api/ai/validate/ip?ip=8.8.8.8` | Geolocate an IP | None |
| POST | `/api/ai/assess/:transactionId` | Multi-agent risk assessment | Required |
| POST | `/api/ai/investigate/:transactionId` | Fraud investigation (admin only) | Admin |
| DELETE | `/api/ai/investigate/session/:sessionId` | Close investigation session (admin only) | Admin |
| GET | `/api/ai/insights/:userId` | AI financial coaching | Required |

### Public APIs (no auth required)

Results are cached in Redis. No API keys needed.

| Method | Path | Description | Source |
|--------|------|-------------|--------|
| GET | `/api/public/rates?base=USD` | Live exchange rates | open.er-api.com |
| GET | `/api/public/convert?amount=100&from=USD&to=EUR` | Currency conversion | open.er-api.com |
| GET | `/api/public/rates/historical?date=2024-01-15&base=USD` | Historical rates | frankfurter.app |
| GET | `/api/public/rates/historical/range?start=2024-01-01&end=2024-01-31&base=USD` | Rate range (max 365 days) | frankfurter.app |
| GET | `/api/public/countries` | All countries with currency codes | restcountries.com |
| GET | `/api/public/country/:code` | Country info (name, currencies, flag) | restcountries.com |
| GET | `/api/public/vat?country=DE` | EU VAT rates | vatcomply.com |
| GET | `/api/public/crypto?coins=bitcoin,ethereum` | Live crypto prices in USD | coingecko.com / coincap.io |
| GET | `/api/public/crypto/convert?amount=500&coin=bitcoin` | Convert USD to crypto | coingecko.com / coincap.io |
| GET | `/api/public/bin/:bin` | Card BIN lookup (issuer, type, country) | binlist.net |
| GET | `/api/public/postcode/:country/:postcode` | Postcode lookup (city, state, coords) | zippopotam.us |

### Health
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/health` | Basic health check |
| GET | `/api/health/live` | Liveness probe |
| GET | `/api/health/ready` | Readiness check (MongoDB + Redis + RabbitMQ) |
| GET | `/api/health/detailed` | Per-dependency status + active WebSocket connections |

---

## WebSocket events

Connect with Socket.IO and authenticate with your PASETO access token:

```js
socket.emit("authenticate", { token: "your-access-token" });
```

### Payout events
| Event | Description |
|-------|-------------|
| `PAYOUT_INITIATED` | Payout accepted and queued |
| `PAYOUT_PROCESSING` | Worker picked it up |
| `PAYOUT_COMPLETED` | Balance deducted, done |
| `PAYOUT_FAILED` | Something went wrong |

### NexusFlow chat events
| Event | Description |
|-------|-------------|
| `MESSAGE_CREATED` | New message in a channel or DM |
| `MESSAGE_UPDATED` | Message edited |
| `MESSAGE_DELETED` | Message deleted |
| `REACTION_UPDATED` | Reaction added or removed |

---

## Workflow node types

Workflows are defined as a directed graph of nodes executed by the workflow worker.

| Node type | What it does |
|-----------|-------------|
| `ai_agent` | Calls an AI model (Groq / NVIDIA NIM / OpenRouter). Tasks: `score_fraud`, `summarise`, `sentiment`, `translate`, `research`, `document_qa`, `smart_reply`, `explain_code`, `critique` |
| `send_message` | Posts a message to a workspace channel |
| `send_email` | Sends an email via Nodemailer |
| `http_request` | Calls an external webhook or API |
| `condition` | If/else branching based on a field value |
| `delay` | Waits N seconds (max 60) before continuing |

Trigger types: `message_keyword`, `schedule`, `webhook`, `manual`

Node configs support `{{variable}}` interpolation from previous node outputs.

---

## AI providers

| Provider | Used for | Key |
|----------|----------|-----|
| Groq (Llama 3.3 70B) | Fraud scoring, anomaly detection, risk assessment, investigation, financial coaching | `GROQ_API_KEY` |
| NVIDIA NIM | Summarisation, sentiment analysis, translation, classification | `NVIDIA_API_KEY` |
| OpenRouter (25+ free models) | Research, document Q&A, smart replies, code explanation, critic pass | `OPENROUTER_API_KEY` |

All AI features are optional and disabled by default (`ENABLE_AI_FEATURES=false`).

---

## Rate limiting

All limiters use Redis so counters are shared across instances and survive restarts.

| Endpoint | Limit |
|----------|-------|
| Global | 100 req / 15 min per IP |
| `POST /api/auth/register` | 5 req / hour per IP |
| `POST /api/auth/login` | 10 req / 15 min per IP |
| `POST /api/auth/forgot-password` | 5 req / hour per IP |
| `POST /api/auth/verify-otp/:email` | 5 req / 15 min per IP |
| `POST /api/auth/refresh-token` | 20 req / 15 min per IP |
| `POST /api/payout` | 10 req / min per user |
| Public API proxy | 60 req / min per IP |

---

## Scripts

Generate PASETO Ed25519 key pairs (run once, paste output into `.env`):

```bash
node scripts/generate-keys.js
```

Test PASETO token sign/verify:

```bash
node scripts/test-paseto.mjs
```

Generate a random secret (for `ADMIN_SECRET` etc.):

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

---

## Testing

```bash
npm test
```

Tests live in `src/__tests__/` and use Jest with property-based tests via `fast-check`.

Test files:
- `auth.service.test.js` — register, login, logout, refresh token flows
- `auth.tokens.test.js` — PASETO token sign/verify
- `middleware.test.js` — auth and rate limit middleware
- `nexus-flow.test.js` — NexusFlow WebSocket emission (channels + DMs)
- `simple.test.js` — sanity checks

---

## Project structure

```
src/
├── app.js                  # Application bootstrap and DI wiring
├── config/                 # MongoDB, Redis, RabbitMQ, Socket.IO setup
├── controllers/            # Route handlers (thin — delegate to services)
├── middleware/             # Auth, rate limiting, sanitization, error handling
├── models/                 # Mongoose schemas
├── routes/                 # Express routers
├── services/               # Business logic
├── validators/             # Zod schemas for request validation
├── worker/
│   ├── index.js            # Payout worker (payout_queue)
│   └── workflow.worker.js  # Workflow worker (workflow_queue)
├── email/                  # Nodemailer templates
├── utils/                  # Logger, helpers, constants
└── __tests__/              # Jest test suite
scripts/
├── generate-keys.js        # PASETO key pair generator
└── test-paseto.mjs         # PASETO smoke test
docker/
├── Dockerfile.gateway
├── Dockerfile.worker
└── Dockerfile.workflow-worker
```
