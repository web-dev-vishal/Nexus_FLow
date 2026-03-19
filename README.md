# SwiftPay

AI-powered payout processing system with real-time WebSocket updates.

## What it does

- User auth (register, email verification, login, OTP password reset)
- Payout initiation with distributed locking to prevent double-spend
- AI fraud scoring via Groq (optional)
- IP geolocation and currency validation (optional)
- Real-time payout status updates via Socket.IO
- Async payout processing via RabbitMQ worker
- Redis for sessions, rate limiting, balance cache, and pub/sub

## Stack

Node.js · Express · MongoDB · Redis · RabbitMQ · Socket.IO · Groq

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

Edit `.env` and fill in your values. At minimum you need:
- `MONGO_URI`
- `REDIS_HOST` / `REDIS_PASSWORD`
- `RABBITMQ_URL`
- `ACCESS_SECRET`, `REFRESH_SECRET`, `VERIFY_SECRET`
- `MAIL_USER`, `MAIL_PASS`

### 3. Start infrastructure (Docker)

```bash
docker-compose up mongodb redis rabbitmq -d
```

### 4. Run the API server

```bash
npm run dev
```

### 5. Run the worker (separate terminal)

```bash
npm run worker
```

---

## Docker (full stack)

```bash
docker-compose up --build
```

This starts MongoDB, Redis, RabbitMQ, the API gateway, and the worker.

---

## API routes

### Auth
| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/auth/register` | Register a new user |
| GET | `/api/auth/verify-email` | Verify email (Bearer token) |
| POST | `/api/auth/login` | Login |
| POST | `/api/auth/logout` | Logout (requires auth) |
| POST | `/api/auth/refresh-token` | Get a new access token |
| GET | `/api/auth/profile` | Get current user (requires auth) |
| POST | `/api/auth/forgot-password` | Send OTP to email |
| POST | `/api/auth/verify-otp/:email` | Verify OTP |
| POST | `/api/auth/change-password/:email` | Change password |

### Payout
| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/payout` | Initiate a payout |
| GET | `/api/payout/:transactionId` | Get transaction status |
| GET | `/api/payout/user/:userId/balance` | Get user balance |
| GET | `/api/payout/user/:userId/history` | Get transaction history |

### Health
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/health` | Basic health check |
| GET | `/api/health/live` | Liveness probe |
| GET | `/api/health/ready` | Readiness check (all deps) |
| GET | `/api/health/detailed` | Detailed dependency status |

### AI / Validation
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/ai/usage` | API usage counters (ipapi, exchangerate, groq) |
| GET | `/api/ai/currencies` | List of supported currencies |
| GET | `/api/ai/validate/currency?currency=EUR&amount=100` | Validate currency + get exchange rate |
| GET | `/api/ai/validate/ip?ip=8.8.8.8` | Geolocate an IP address |

### Public APIs (no auth required)

All powered by free public APIs — no API keys needed. Results are cached in Redis.

| Method | Path | Description | Source |
|--------|------|-------------|--------|
| GET | `/api/public/rates?base=USD` | Live exchange rates for all currencies | open.er-api.com |
| GET | `/api/public/convert?amount=100&from=USD&to=EUR` | Convert between currencies | open.er-api.com |
| GET | `/api/public/rates/historical?date=2024-01-15&base=USD` | Exchange rates for a specific past date | frankfurter.app |
| GET | `/api/public/rates/historical/range?start=2024-01-01&end=2024-01-31&base=USD` | Exchange rates over a date range (max 365 days) | frankfurter.app |
| GET | `/api/public/countries` | List all countries with currency codes | restcountries.com |
| GET | `/api/public/country/:code` | Country info (name, currencies, flag, calling code) | restcountries.com |
| GET | `/api/public/vat?country=DE` | VAT rates for EU countries | vatcomply.com |
| GET | `/api/public/crypto?coins=bitcoin,ethereum` | Live crypto prices in USD (CoinGecko, falls back to CoinCap) | coingecko.com / coincap.io |
| GET | `/api/public/crypto/convert?amount=500&coin=bitcoin` | Convert USD to crypto | coingecko.com / coincap.io |
| GET | `/api/public/bin/:bin` | Card BIN lookup — issuer, card type, country (first 6-8 digits) | binlist.net |
| GET | `/api/public/postcode/:country/:postcode` | Postcode/ZIP lookup — city, state, coordinates | zippopotam.us |

---

## WebSocket events

Connect to the server with Socket.IO, then authenticate:

```js
socket.emit("authenticate", { userId: "your-user-id" });
```

Events you'll receive:
- `PAYOUT_INITIATED` — payout accepted and queued
- `PAYOUT_PROCESSING` — worker picked it up
- `PAYOUT_COMPLETED` — balance deducted, done
- `PAYOUT_FAILED` — something went wrong

---

## Generating secrets

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Run this three times for `ACCESS_SECRET`, `REFRESH_SECRET`, and `VERIFY_SECRET`.
