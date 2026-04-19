# Wheleers

The first decentralised ride-hailing app. Riders pay in USDT, drivers settle on-chain, idle funds earn DeFi yield automatically. Built on an event-driven architecture — services never call each other directly, everything flows through Kafka.

---

## Table of contents

1. [Project overview](#1-project-overview)
2. [Monorepo structure](#2-monorepo-structure)
3. [How the system fits together](#3-how-the-system-fits-together)
4. [Packages — shared libraries](#4-packages--shared-libraries)
   - [kafka-schemas](#41-kafka-schemas)
   - [kafka-client](#42-kafka-client)
   - [db](#43-db)
   - [config](#44-config)
   - [blockchain](#45-blockchain)
5. [Apps — services](#5-apps--services)
   - [api-gateway](#51-api-gateway)
   - [ride-service](#52-ride-service)
   - [payment-service](#53-payment-service)
   - [wallet-service](#54-wallet-service)
   - [notification-worker](#55-notification-worker)
   - [compliance-worker](#56-compliance-worker)
   - [defi-scheduler](#57-defi-scheduler)
6. [Event flow — producer to consumer](#6-event-flow--producer-to-consumer)
   - [User registration](#61-user-registration)
   - [Complete ride lifecycle](#62-complete-ride-lifecycle)
   - [NGN deposit (Web2 onramp)](#63-ngn-deposit-web2-onramp)
   - [DeFi idle detection and staking](#64-defi-idle-detection-and-staking)
7. [WebSocket event schema](#7-websocket-event-schema)
8. [Kafka topics](#8-kafka-topics)
9. [Infrastructure](#9-infrastructure)
10. [Getting started](#10-getting-started)
11. [Environment variables](#11-environment-variables)

---

## 1. Project overview

Wheleers operates as a marketplace with two sides — riders and drivers.

**Riders** fund a USDT wallet through authenticated Pouch onramp sessions (fiat → stablecoin via the provider's supported rails and networks) or by sending crypto directly. They book rides and pay from their in-app balance. If their balance sits idle, it automatically earns yield via DeFi protocols (Aave, Compound) using ERC-4337 smart accounts with session keys — no manual signing required.

**Drivers** onboard through a KYC flow (licence, vehicle details, face verification). Once approved they go online, accept ride requests, and receive USDT payouts per completed trip. Wheleers takes 0.3% of the driver's profit per ride — never when the driver makes no profit.

**On-chain:** Consent to record is logged on-chain. Post-ride ratings are logged on-chain. Recording hashes are logged on-chain (not the recordings themselves). Settlements happen on-chain. Every financial action has a verifiable chain of evidence.

---

## 2. Monorepo structure

```
wheleers/
├── apps/
│   ├── api-gateway/          # WebSocket server + auth/payment HTTP routes
│   ├── ride-service/         # Matching, GPS processing, trip lifecycle
│   ├── payment-service/      # Pouch settlement audit + ride fee calculation
│   ├── wallet-service/       # USDT balances, DeFi staking, smart accounts
│   ├── notification-worker/  # Expo push, Twilio SMS, in-app notifications
│   ├── compliance-worker/    # On-chain logs, recordings, disputes, KYC review
│   └── defi-scheduler/       # Idle fund detection cron, yield harvesting
│
├── packages/
│   ├── kafka-schemas/        # Zod event schemas + topic constants (the contract)
│   ├── kafka-client/         # KafkaJS factory — producer, consumer, DLQ, shutdown
│   ├── db/                   # Prisma schema + scoped query clients per service
│   ├── config/               # Env validation + constants (fees, GPS, ride, DeFi)
│   └── blockchain/           # viem, Solana, Stellar clients + contract helpers
│
├── infra/
│   ├── docker-compose.yml
│   ├── docker-compose.dev.yml
│   └── kafka/
│       └── topics.sh         # Creates all Kafka topics on startup
│
├── turbo.json
└── package.json
```

---

## 3. How the system fits together

There are three communication layers in Wheleers:

**Client ↔ Server: WebSocket**
The mobile app (rider and driver) maintains a persistent WebSocket connection to `api-gateway`. Every user action — requesting a ride, sending a GPS ping, cancelling — comes in as a WebSocket event. Every server-side update — driver assigned, GPS position update, payment confirmed — goes back as a WebSocket event. There are no polling HTTP calls during an active session.

**Server ↔ Server: Kafka**
Services never call each other's APIs. When a significant domain event happens — ride completed, payment received, driver went online — the service that owns that domain writes an event to the appropriate Kafka topic. Every other service that cares about that event has a consumer subscribed to that topic. They react independently and in parallel.

This is what makes the system scale: when a ride completes, `ride-service` emits one `RIDE_COMPLETED` event. `payment-service`, `wallet-service`, `compliance-worker`, and `notification-worker` all pick it up simultaneously. No service waits on another.

**HTTP control plane**
The gateway exposes a small authenticated REST surface for auth and Pouch session orchestration:
- `POST /auth/privy` — Privy auth callback
- `GET /payments/pouch/health` — provider health proxy
- `GET /payments/pouch/channels` — supported Pouch chains/networks
- `POST /payments/pouch/sessions` — authenticated onramp/offramp session creation
- `GET /payments/pouch/sessions/:id` — authenticated session fetch + settlement detection
- `GET /payments/pouch/sessions/:id/quote` — quote lookup
- `POST /payments/pouch/sessions/:id/identify` — OTP email initiation
- `POST /payments/pouch/sessions/:id/verify-otp` — OTP verification
- `GET /payments/pouch/sessions/:id/kyc-requirements` — KYC schema fetch
- `POST /payments/pouch/sessions/:id/kyc` — KYC document submission

Everything else is WebSocket or Kafka.

---

## 4. Packages — shared libraries

Packages are internal libraries. Apps import from them. Apps never import from each other.

### 4.1 kafka-schemas

**Location:** `packages/kafka-schemas/`
**Dependency of:** every app

This is the contract layer — the single source of truth for what every Kafka event looks like. If `ride-service` changes the shape of a `RIDE_COMPLETED` event without updating this package, every consumer of that event will get a TypeScript error immediately.

Every event file exports:
- A Zod schema for runtime validation
- TypeScript types inferred from the schema
- A discriminated union of all events on that topic

**Files:**

| File | Events |
|------|--------|
| `events/user.events.ts` | `USER_CREATED`, `USER_KYC_APPROVED`, `USER_ROLE_CHANGED`, `USER_CONSENT_LOGGED` |
| `events/driver.events.ts` | `DRIVER_ONLINE`, `DRIVER_OFFLINE`, `DRIVER_KYC_SUBMITTED`, `DRIVER_KYC_APPROVED`, `DRIVER_KYC_REJECTED` |
| `events/ride.events.ts` | `RIDE_REQUESTED`, `RIDE_DRIVER_ASSIGNED`, `RIDE_STARTED`, `RIDE_COMPLETED`, `RIDE_CANCELLED`, `RIDE_DRIVER_REJECTED` |
| `events/payment.events.ts` | `PAYMENT_SESSION_CREATED`, `ONRAMP_SETTLED`, `DRIVER_PAYOUT`, `PENALTY_APPLIED`, `CRYPTO_DEPOSIT_RECEIVED` |
| `events/wallet.events.ts` | `WALLET_CREDITED`, `WALLET_DEBITED`, `WALLET_LOCKED`, `WALLET_UNLOCKED` |
| `events/gps.events.ts` | `GPS_UPDATE`, `GPS_PROCESSED` |
| `events/defi.events.ts` | `IDLE_FUNDS_DETECTED`, `DEFI_STAKED`, `DEFI_UNSTAKE_REQUESTED`, `DEFI_UNSTAKED`, `YIELD_HARVESTED` |
| `events/compliance.events.ts` | `GPS_STALE_WARNING`, `FEEDBACK_LOGGED`, `DISPUTE_OPENED`, `DISPUTE_RESOLVED`, `RECORDING_STORED` |
| `events/notification.events.ts` | `PUSH_SEND`, `SMS_SEND`, `IN_APP_SEND` |
| `topics.ts` | `TOPICS` const — all topic name strings. Never hardcode topic names in apps. |
| `registry.ts` | `parseKafkaEvent(topic, rawValue)` — validates and types in one call |

**How to use in a consumer:**

```typescript
import { parseKafkaEvent, TOPICS } from '@wheleers/kafka-schemas';

// Inside your eachMessage handler:
const event = parseKafkaEvent(TOPICS.RIDE_EVENTS, message.value.toString());

if (event.eventType === 'RIDE_COMPLETED') {
  // event is fully typed as RideCompletedEvent here
  await settleRide(event.rideId, event.fareUsdt);
}
```

---

### 4.2 kafka-client

**Location:** `packages/kafka-client/`
**Dependency of:** every app

Wraps KafkaJS. Every app calls `createProducer` and `createConsumer` and gets:
- Consistent retry behaviour (exponential backoff, 5 attempts)
- Automatic JSON serialisation/deserialisation
- Dead-letter queue routing on handler failure
- Graceful shutdown on SIGTERM/SIGINT

**Files:**

| File | What it does |
|------|-------------|
| `connection.ts` | Singleton `Kafka` instance — one TCP connection pool per process |
| `producer.ts` | `createProducer(config)` — returns `WheelersProducer` with `send` and `sendBatch` |
| `consumer.ts` | `createConsumer(config)` — returns `WheelersConsumer` with error boundary built in |
| `dlq.ts` | `sendToDlq(payload)` — parks failed messages in `<topic>.dlq` for inspection |
| `admin.ts` | `ensureTopics(topics)` — idempotent topic creation at service startup |
| `shutdown.ts` | `registerShutdownHandlers(name)`, `onShutdown(fn)` — clean disconnect on exit |
| `types.ts` | All TypeScript interfaces: `WheelersProducer`, `WheelersConsumer`, `MessageContext`, etc. |

**How a service wires up — complete index.ts pattern:**

```typescript
import { createProducer, createConsumer, ensureTopics, buildTopicList,
         TOPIC_PRESETS, onShutdown, registerShutdownHandlers } from '@wheleers/kafka-client';
import { TOPICS } from '@wheleers/kafka-schemas';

registerShutdownHandlers('ride-service');

await ensureTopics(buildTopicList([
  [TOPICS.RIDE_EVENTS,   TOPIC_PRESETS.STANDARD],
  [TOPICS.GPS_STREAM,    TOPIC_PRESETS.GPS],
  [TOPICS.GPS_PROCESSED, TOPIC_PRESETS.GPS],
]));

const producer = await createProducer({ serviceId: 'ride-service' });
const consumer = await createConsumer({ groupId:  'ride-service' });

onShutdown(() => producer.disconnect());
onShutdown(() => consumer.disconnect());

await consumer.subscribe([TOPICS.RIDE_EVENTS], rideEventHandler);
```

**How the dead-letter queue works:**

When a consumer handler throws — bad JSON, Zod validation failure, DB error, anything — the error is caught internally. The raw message plus the error details are written to `<topic>.dlq` (e.g. `ride.events.dlq`). The offset commits. The consumer moves on. Nothing crashes. DLQ messages are retained for 30 days for manual inspection or replay.

---

### 4.3 db

**Location:** `packages/db/`
**Dependency of:** all apps except defi-scheduler (which uses wallet-service for DB writes)

Single Prisma schema. All 13 models live in one file. Each service gets a scoped client that only exposes queries for its own domain tables.

**Models:**

| Model | Owned by |
|-------|----------|
| `User` | api-gateway (writes), all services (reads via events) |
| `UserConsent` | compliance-worker |
| `Driver` | ride-service (status/location), compliance-worker (KYC) |
| `DriverKycReview` | compliance-worker |
| `Wallet` | wallet-service |
| `VirtualAccount` | payment-service |
| `Transaction` | wallet-service |
| `Ride` | ride-service |
| `GpsLog` | ride-service |
| `Recording` | compliance-worker |
| `Dispute` | compliance-worker |
| `Feedback` | compliance-worker |
| `DefiPosition` | wallet-service |
| `YieldHarvest` | wallet-service |
| `Notification` | notification-worker |

**Scoped clients:**

Each client file only exposes queries for its service's tables. `ride-service` imports `rideClient` and `driverClient`. It never touches `walletClient` or `paymentClient`. This is convention enforced by code review — if you find a service importing the wrong client, that's a boundary violation.

**Critical design — atomic balance operations:**

Every USDT balance change in `wallet.client.ts` runs inside a Prisma `$transaction`. `credit`, `debit`, `lockFunds`, `moveToStaked` all write the wallet row and the transaction ledger row atomically. If either write fails, both roll back. This ensures the ledger is always a faithful record of every balance change — you can sum all transactions for a wallet and get the current balance.

**To run migrations:**

```bash
cd packages/db
npm run db:generate      # generates Prisma client from schema
npm run db:migrate:dev   # creates tables in your local Postgres
```

---

### 4.4 config

**Location:** `packages/config/`
**Dependency of:** every app

Two things: env validation and constants.

**Env validation** — each service has its own validator that calls `process.exit(1)` with a clear error message if any required variable is missing. This means misconfigured deployments fail immediately at startup with a readable error, not silently at runtime.

```typescript
// In ride-service index.ts:
import { validateSharedEnv, validateRideEnv } from '@wheleers/config';
validateSharedEnv();  // DATABASE_URL, KAFKA_BROKERS, REDIS_URL
validateRideEnv();    // MATCH_RADIUS_KM, DRIVER_ACCEPT_TIMEOUT_S
```

**Constants** — every magic number used across services lives here:

| File | Constants |
|------|-----------|
| `constants/fees.ts` | `PLATFORM_FEE_PERCENT` (0.003), cancellation penalty amounts |
| `constants/gps.ts` | `STALE_MOVEMENT_THRESHOLD_METRES` (50), `STALE_TIME_WINDOW_MINUTES` (5) |
| `constants/ride.ts` | `DRIVER_ACCEPT_TIMEOUT_SECONDS` (15), `MAX_MATCH_ATTEMPTS` (5) |
| `constants/defi.ts` | Tier thresholds, APY ranges, unstake lead time |
| `constants/chains.ts` | Chain IDs, USDT contract addresses per chain |

If `payment-service` and `ride-service` both need `PLATFORM_FEE_PERCENT`, they both import it from `@wheleers/config`. There's never two hardcoded `0.003` values drifting apart.

---

### 4.5 blockchain

**Location:** `packages/blockchain/`
**Dependency of:** wallet-service, compliance-worker

All chain interaction code lives here. No app writes raw viem or Solana calls directly.

**Files:**

| File | What it does |
|------|-------------|
| `chains/evm.config.ts` | Chain definitions, USDT addresses, `getRpcUrl()` |
| `chains/solana.config.ts` | Solana cluster config, USDT mint address |
| `chains/stellar.config.ts` | Horizon + Soroban RPC URLs, USDC asset (Stellar uses USDC) |
| `clients/evm.client.ts` | `getPublicClient(chain)`, `getWalletClient(chain)` — viem factories |
| `clients/solana.client.ts` | `getSolanaConnection()`, `getPlatformKeypair()` |
| `clients/stellar.client.ts` | `getHorizonServer()`, `getPlatformStellarKeypair()` |
| `contracts/compliance-log.ts` | `logConsentOnChain`, `logFeedbackOnChain`, `logRecordingHashOnChain`, `verifyConsentOnChain` |
| `contracts/smart-account.ts` | `createSessionKey`, `isSessionKeyValid`, `revokeSessionKey` |
| `helpers/retry.ts` | `withRetry(fn, options)` — exponential backoff for failed tx sends |
| `helpers/consent.ts` | `buildConsentMessage`, `verifyConsentSignature` |
| `helpers/gas.ts` | `estimateGasWithBuffer`, `getCurrentGasPrice` |

**EVM client pattern:**

```typescript
import { getPublicClient, getWalletClient } from '@wheleers/blockchain';

// Read-only — checking a balance, reading contract state
const client = getPublicClient('base');
const balance = await client.getBalance({ address: '0x...' });

// Signing — sending a transaction
const signer = getWalletClient('base');
const txHash = await signer.writeContract({ ... });
```

---

## 5. Apps — services

Each app is an independent Node.js process. It owns its Kafka topics, its section of the DB schema (by convention), and its Docker container. Services are started via Docker Compose and communicate exclusively through Kafka.

### 5.1 api-gateway

**What it owns:** WebSocket connections, the 3 HTTP endpoints, session registry in Redis.

**What it does:**
- Authenticates every WebSocket connection via Privy JWT on connect
- Translates inbound WebSocket events from clients into Kafka events
- Translates Kafka events destined for specific users into WebSocket pushes
- Holds the socket registry: `userId → socketId` mapping in Redis so any service can push to a specific user

**Internal structure:**

```
apps/api-gateway/src/
├── websocket/
│   ├── server.ts          # ws server setup, auth middleware, connection registry
│   ├── handlers/
│   │   ├── ride.handler.ts      # ride:request, ride:cancel, ride:end
│   │   ├── driver.handler.ts    # driver:online, driver:offline, driver:gps
│   │   └── wallet.handler.ts    # wallet:deposit_intent
│   └── publisher.ts       # Kafka producer — sends events from client actions
├── http/
│   ├── auth.route.ts       # POST /auth/privy
│   └── pouch.route.ts      # Pouch session + KYC routes
└── kafka/
    └── consumer.ts         # Consumes events meant for clients, pushes to socket
```

**Kafka topics consumed:** `ride.events` (RIDE_DRIVER_ASSIGNED, RIDE_COMPLETED), `wallet.events` (WALLET_CREDITED), `notification.events` (IN_APP_SEND), `gps.processed`

**Kafka topics produced:** `user.events`, `driver.events`, `ride.events`, `gps.stream`, `payment.events`

---

### 5.2 ride-service

**What it owns:** `Ride`, `GpsLog`, `Driver` (status and location only).

**What it does:**
- Listens for `RIDE_REQUESTED` → runs driver matching (Haversine SQL query on nearby online drivers)
- Sends ride request to nearest driver → waits `DRIVER_ACCEPT_TIMEOUT_SECONDS` → tries next if rejected
- Processes `GPS_UPDATE` events → enriches with distance delta → produces `GPS_PROCESSED`
- Runs GPS stale detection cron every 30s — if driver hasn't moved >50m in 5 minutes, emits `GPS_STALE_WARNING`
- Manages ride state machine: `REQUESTED → MATCHING → DRIVER_ASSIGNED → DRIVER_EN_ROUTE → ARRIVED → IN_PROGRESS → COMPLETED`

**Internal structure:**

```
apps/ride-service/src/
├── consumers/
│   ├── ride-requested.consumer.ts
│   ├── driver-events.consumer.ts   # DRIVER_ONLINE/OFFLINE — updates availability pool
│   └── gps-update.consumer.ts
├── producers/
│   ├── ride-events.producer.ts
│   └── gps-processed.producer.ts
├── handlers/
│   ├── match-driver.handler.ts     # core matching logic
│   ├── gps-monitor.handler.ts      # stale detection cron
│   └── trip-lifecycle.handler.ts
└── index.ts
```

**Kafka topics consumed:** `ride.events`, `driver.events`, `gps.stream`

**Kafka topics produced:** `ride.events`, `gps.processed`, `compliance.events` (GPS_STALE_WARNING), `notification.events`

---

### 5.3 payment-service

**What it owns:** `VirtualAccount`, reads `Transaction` for idempotency checks.

**What it does:**
- Consumes settled Pouch onramp events from `payment.events`
- Applies settlement idempotency checks and records provider settlement metadata
- On `RIDE_COMPLETED`: calculates gross fare, driver costs, platform fee (0.3% of profit only), net payout → emits `DRIVER_PAYOUT`
- On `RIDE_CANCELLED`: calculates penalty by stage → emits `PENALTY_APPLIED`
- Detects on-chain USDT deposits → emits `CRYPTO_DEPOSIT_RECEIVED`

**Pouch funding flow:**

```
Authenticated client → POST /payments/pouch/sessions
  → Pouch session is created with user-linked metadata
  → client completes OTP + KYC through gateway-backed Pouch routes
  → client polls GET /payments/pouch/sessions/:id
  → api-gateway detects a settled onramp and emits ONRAMP_SETTLED
  → payment-service records the settlement idempotently
  → wallet-service credits the balance
```

**Kafka topics consumed:** `payment.events` (its own), `ride.events` (RIDE_COMPLETED, RIDE_CANCELLED)

**Kafka topics produced:** `payment.events`, `notification.events`

---

### 5.4 wallet-service

**What it owns:** `Wallet`, `Transaction`, `DefiPosition`, `YieldHarvest`.

**What it does:**
- On `USER_CREATED`: creates the wallet record and Korapay virtual account
- On `ONRAMP_SETTLED` or `CRYPTO_DEPOSIT_RECEIVED`: credits USDT balance (atomic DB transaction)
- On `RIDE_DRIVER_ASSIGNED`: locks ride fare in wallet
- On `RIDE_COMPLETED`: unlocks fare, debits final amount, credits driver
- On `DRIVER_PAYOUT`: credits driver wallet
- On `IDLE_FUNDS_DETECTED`: executes DeFi stake via smart account session key
- On `DEFI_UNSTAKE_REQUESTED`: executes unstake, returns funds to wallet

**Kafka topics consumed:** `user.events`, `payment.events`, `ride.events`, `defi.events`

**Kafka topics produced:** `wallet.events`, `defi.events`, `notification.events`

---

### 5.5 notification-worker

**What it owns:** `Notification` table.

**What it does:**
- The only consumer of `notification.events`
- `PUSH_SEND` → calls Expo Push API
- `SMS_SEND` → calls Twilio
- `IN_APP_SEND` → writes to `Notification` table + pushes to user's open WebSocket via Redis pub/sub

Every other service that wants to notify a user produces a `PUSH_SEND` or `IN_APP_SEND` event. notification-worker is the only thing that knows about Expo or Twilio. No other service has those SDKs.

**Kafka topics consumed:** `notification.events`

**Kafka topics produced:** none

---

### 5.6 compliance-worker

**What it owns:** `Recording`, `Dispute`, `Feedback`, `UserConsent`, `DriverKycReview`.

**What it does:**
- On `USER_CREATED`: logs recording consent on-chain via `compliance-log.ts`
- On `DRIVER_KYC_SUBMITTED`: stores documents on IPFS, creates review record, alerts admin
- On `RIDE_STARTED`: verifies consent on-chain, starts encrypted recording if verified
- On `RIDE_COMPLETED`: encrypts recording, uploads to IPFS, logs SHA-256 hash on-chain → emits `RECORDING_STORED`
- On `FEEDBACK_LOGGED`: writes feedback to DB, logs rating on-chain
- On `DISPUTE_OPENED`: fetches recording CID, surfaces to admin dashboard, freezes pending payouts
- On `GPS_STALE_WARNING`: already consumed by notification-worker; compliance-worker logs the event for audit trail

**Kafka topics consumed:** `user.events`, `driver.events`, `ride.events`, `compliance.events`

**Kafka topics produced:** `compliance.events`, `notification.events`

---

### 5.7 defi-scheduler

**What it owns:** no DB tables directly — reads via wallet queries, writes through wallet-service events.

**What it does:**
- Runs a cron job (default: every hour) that calls `defiClient.findIdleWallets()`
- For each idle wallet: emits `IDLE_FUNDS_DETECTED` → wallet-service picks it up and executes the stake
- Monitors active DeFi positions — when yield is harvestable, emits `YIELD_HARVESTED`
- When `RIDE_REQUESTED` is detected for a user with staked funds: emits `DEFI_UNSTAKE_REQUESTED` with `urgency: 'immediate'` so funds are available for the ride

**Kafka topics consumed:** `ride.events` (RIDE_REQUESTED — to trigger unstake), `defi.events`

**Kafka topics produced:** `defi.events`

---

## 6. Event flow — producer to consumer

### 6.1 User registration

```
User opens app → Privy auth (Google / Apple / Wallet)
  → POST /auth/privy
  → api-gateway verifies Privy JWT
  → api-gateway produces USER_CREATED to user.events

USER_CREATED consumed by:
  ├── wallet-service    → creates Wallet record + VirtualAccount (Korapay API)
  ├── compliance-worker → logs recording consent on-chain
  └── notification-worker → sends welcome push
```

### 6.2 Complete ride lifecycle

```
Rider taps "Request ride"
  → WebSocket event ride:request
  → api-gateway produces RIDE_REQUESTED to ride.events

RIDE_REQUESTED consumed by ride-service:
  → queries nearby online drivers (Haversine SQL)
  → sends ride offer to nearest driver's WebSocket
  → driver accepts within 15s
  → produces RIDE_DRIVER_ASSIGNED to ride.events

RIDE_DRIVER_ASSIGNED consumed by:
  ├── wallet-service    → locks ride fare (WALLET_LOCKED)
  ├── api-gateway       → pushes driver details to rider's WebSocket
  └── notification-worker → sends "Driver on the way" push to rider

Driver GPS pings every 3 seconds:
  → WebSocket event driver:gps
  → api-gateway produces GPS_UPDATE to gps.stream

GPS_UPDATE consumed by ride-service:
  → calculates distance delta + stale check
  → produces GPS_PROCESSED to gps.processed

GPS_PROCESSED consumed by:
  ├── api-gateway       → pushes driver location to rider's WebSocket (live map)
  └── compliance-worker → checks isStale flag, logs GPS snapshots to DB every 30s

Both parties tap "End ride"
  → api-gateway produces RIDE_COMPLETED to ride.events

RIDE_COMPLETED consumed by:
  ├── payment-service   → calculates fare + 0.3% fee → produces DRIVER_PAYOUT
  ├── wallet-service    → unlocks rider funds, debits final fare
  ├── compliance-worker → finalises recording, uploads IPFS, logs hash on-chain
  └── notification-worker → sends completion summary to both rider and driver

DRIVER_PAYOUT consumed by:
  ├── wallet-service    → credits driver wallet → produces WALLET_CREDITED
  └── notification-worker → sends earnings summary push to driver
```

### 6.3 Fiat onramp (Pouch)

```
User opens an authenticated Pouch onramp session from the frontend

api-gateway proxies the Pouch session lifecycle:
  → session creation
  → quote lookup
  → identify / verify-otp
  → kyc-requirements / kyc submission

Once Pouch marks the session settled and the client fetches session state:
  → api-gateway produces ONRAMP_SETTLED to payment.events

ONRAMP_SETTLED consumed by:
  ├── wallet-service    → credits USDT balance → produces WALLET_CREDITED
  └── payment-service   → records settlement metadata idempotently
```

### 6.4 DeFi idle detection and staking

```
defi-scheduler cron runs every hour
  → queries findIdleWallets(thresholdUsdt: 10, idleHours: 24)
  → for each idle wallet: produces IDLE_FUNDS_DETECTED to defi.events

IDLE_FUNDS_DETECTED consumed by wallet-service:
  → checks if user has opted in
  → calls smart account session key to execute Aave deposit on-chain
  → produces DEFI_STAKED to defi.events
  → updates DB: moveToStaked() + createPosition()

DEFI_STAKED consumed by:
  ├── compliance-worker → logs stake on-chain
  └── notification-worker → sends "Your funds are now earning yield" push

Rider requests a ride while funds are staked:
  → RIDE_REQUESTED detected by defi-scheduler
  → produces DEFI_UNSTAKE_REQUESTED with urgency: 'immediate'
  → wallet-service executes unstake (Tier 1 exits instantly from Aave)
  → produces DEFI_UNSTAKED
  → wallet-service calls moveFromStaked()
  → funds available for ride payment
```

---

## 7. WebSocket event schema

All WebSocket messages follow the same envelope:

```typescript
// Client → Server
{ type: string; payload: Record<string, unknown> }

// Server → Client
{ type: string; payload: Record<string, unknown>; timestamp: string }
```

**Inbound events (client → server):**

| Type | Payload | Produces |
|------|---------|---------|
| `ride:request` | `{ pickup, destination, fareEstimate }` | `RIDE_REQUESTED` |
| `ride:cancel` | `{ rideId, reason? }` | `RIDE_CANCELLED` |
| `ride:end` | `{ rideId }` | `RIDE_COMPLETED` |
| `ride:arrived` | `{ rideId }` | updates ride status |
| `driver:online` | `{ lat, lng }` | `DRIVER_ONLINE` |
| `driver:offline` | `{}` | `DRIVER_OFFLINE` |
| `driver:gps` | `{ rideId, lat, lng, speedKmh? }` | `GPS_UPDATE` |
| `driver:accept` | `{ rideId }` | `RIDE_DRIVER_ASSIGNED` |
| `driver:reject` | `{ rideId }` | `RIDE_DRIVER_REJECTED` |
| `feedback:submit` | `{ rideId, rating, comment? }` | `FEEDBACK_LOGGED` |
| `dispute:open` | `{ rideId, reason }` | `DISPUTE_OPENED` |

**Outbound events (server → client):**

| Type | Payload | Triggered by |
|------|---------|-------------|
| `ride:matched` | `{ driverId, driverName, eta, vehiclePlate }` | `RIDE_DRIVER_ASSIGNED` |
| `ride:driver_location` | `{ lat, lng, heading, distanceKm }` | `GPS_PROCESSED` |
| `ride:arrived` | `{ rideId }` | driver sends `ride:arrived` |
| `ride:started` | `{ rideId, startedAt }` | `RIDE_STARTED` |
| `ride:completed` | `{ fareUsdt, distanceKm, durationSeconds }` | `RIDE_COMPLETED` |
| `ride:cancelled` | `{ reason, penaltyUsdt }` | `RIDE_CANCELLED` |
| `ride:request` | `{ rideId, pickup, destination, fareEstimate }` | driver receives ride offer |
| `wallet:updated` | `{ balanceUsdt, changeUsdt, changeType }` | `WALLET_CREDITED/DEBITED` |
| `notification:new` | `{ title, body, category, referenceId }` | `IN_APP_SEND` |
| `gps:stale_warning` | `{ rideId, staleMinutes }` | `GPS_STALE_WARNING` |

---

## 8. Kafka topics

| Topic | Partitions | Retention | Purpose |
|-------|-----------|-----------|---------|
| `user.events` | 4 | 7 days | User registration, KYC, consent |
| `driver.events` | 4 | 7 days | Driver availability and KYC |
| `ride.events` | 4 | 7 days | Full ride lifecycle |
| `payment.events` | 4 | 7 days | All payment flows |
| `wallet.events` | 4 | 7 days | Balance changes |
| `gps.stream` | 8 | 1 day | Raw GPS pings from drivers (high volume) |
| `gps.processed` | 8 | 1 day | Enriched GPS with distance + stale flag |
| `defi.events` | 2 | 7 days | DeFi staking and yield |
| `compliance.events` | 2 | 7 days | Recordings, disputes, feedback, GPS stale |
| `notification.events` | 2 | 7 days | All push / SMS / in-app sends |
| `*.dlq` topics | 1 each | 30 days | Dead-letter queue for each topic |

GPS topics get 8 partitions because at 400 concurrent riders that's ~133 GPS events per second — more partitions means more consumer instances can process in parallel.

**Partition key convention:**
- `gps.stream` / `gps.processed`: keyed by `driverId` → all GPS events for a driver are ordered
- `ride.events`: keyed by `rideId` → all state transitions for a ride are ordered
- `payment.events`: keyed by `userId` → payment events per user are ordered
- `wallet.events`: keyed by `walletId`

---

## 9. Infrastructure

Everything runs in Docker. One `docker-compose.yml` in `infra/` starts all services plus Kafka, Postgres, and Redis.

```
infra/docker-compose.yml
  kafka         # KafkaJS in KRaft mode (no Zookeeper)
  postgres      # PostgreSQL 16
  redis         # Redis 7 — socket registry, GPS live state, ride matching cache
  api-gateway   # port 3000
  ride-service
  payment-service
  wallet-service
  notification-worker
  compliance-worker
  defi-scheduler
```

To scale a service: `docker-compose up --scale ride-service=3`. Kafka's consumer groups handle the load distribution automatically — no code changes needed.

---

## 10. Getting started

**Prerequisites:** Docker, Node.js 20+, npm

```bash
# Clone and install
git clone https://github.com/wheleers/wheleers
cd wheleers
npm install

# Generate Prisma client
cd packages/db
npm run db:generate
cd ../..

# Copy env files
cp .env.example .env
# Fill in your Korapay, YellowCard, Privy, and RPC URL values

# Start everything
cd infra
docker-compose up

# Create Kafka topics (first time only)
bash kafka/topics.sh

# Run DB migrations (first time only)
cd ../packages/db
npm run db:migrate:dev
```

**Local dev — run only what you need:**

```bash
# Start infrastructure only
docker-compose up kafka postgres redis

# Run services individually with hot reload
turbo dev --filter=api-gateway --filter=ride-service
```

---

## 11. Environment variables

Every service validates its own env vars at startup using `@wheleers/config`. Below is the full list across all services.

**Shared (all services)**

| Variable | Description |
|----------|-------------|
| `NODE_ENV` | `development` / `production` / `test` |
| `DATABASE_URL` | PostgreSQL connection string |
| `KAFKA_BROKERS` | Comma-separated broker list e.g. `localhost:9092` |
| `KAFKA_CLIENT_ID` | Service name e.g. `ride-service` |
| `REDIS_URL` | Redis connection string |

**api-gateway**

| Variable | Description |
|----------|-------------|
| `PORT` | HTTP/WS port (default: 3000) |
| `PRIVY_VERIFICATION_KEY` | Privy public verification key (PEM) used for access-token signature validation |
| `JWT_SECRET` | Legacy local JWT secret (optional; no longer used for Privy access tokens) |
| `PRIVY_APP_ID` | Privy application ID |
| `PRIVY_APP_SECRET` | Privy application secret |
| `CORS_ORIGINS` | Allowed origins (comma-separated) |

**payment-service**

| Variable | Description |
|----------|-------------|
| `KORAPAY_SECRET_KEY` | Korapay secret key |
| `KORAPAY_PUBLIC_KEY` | Korapay public key |
| `KORAPAY_WEBHOOK_SECRET` | For webhook signature verification |
| `YELLOWCARD_API_KEY` | YellowCard API key |
| `YELLOWCARD_WEBHOOK_SECRET` | For webhook signature verification |
| `PLATFORM_WALLET_ADDRESS` | Address that receives the 0.3% platform fee |

**wallet-service / blockchain**

| Variable | Description |
|----------|-------------|
| `PLATFORM_PRIVATE_KEY` | EVM hot wallet private key (0x-prefixed) |
| `RPC_URL_BASE` | Base chain RPC endpoint |
| `RPC_URL_POLYGON` | Polygon RPC endpoint (optional) |
| `SOLANA_RPC_URL` | Solana RPC endpoint (optional) |
| `STELLAR_SECRET_KEY` | Stellar secret key (S...) (optional) |
| `SMART_ACCOUNT_FACTORY` | ERC-4337 factory contract address |

**compliance-worker**

| Variable | Description |
|----------|-------------|
| `IPFS_API_URL` | IPFS pinning service URL |
| `IPFS_API_KEY` | IPFS pinning service API key |
| `COMPLIANCE_LOG_CONTRACT` | On-chain compliance contract address |
| `RECORDING_ENCRYPTION_KEY` | 64-char hex AES-256-GCM key |

**notification-worker**

| Variable | Description |
|----------|-------------|
| `EXPO_ACCESS_TOKEN` | Expo push notification access token |
| `TWILIO_ACCOUNT_SID` | Twilio account SID |
| `TWILIO_AUTH_TOKEN` | Twilio auth token |
| `TWILIO_FROM_NUMBER` | Twilio phone number |

**defi-scheduler**

| Variable | Description |
|----------|-------------|
| `IDLE_THRESHOLD_USDT` | Minimum balance to qualify for DeFi (default: 10) |
| `IDLE_HOURS` | Hours idle before auto-stake triggers (default: 24) |
| `AAVE_POOL_ADDRESS` | Aave V3 Pool contract address |
| `COMPOUND_COMET` | Compound V3 Comet address |
