# API Gateway Explained (Simple Version)

This file explains how the `api-gateway` works in this backend.

If you remember only one thing, remember this:

- **Privy** proves who the user is.
- **Redis** tracks who is currently connected (live socket/session state).
- **Kafka** moves business events between services (async producers/consumers).

---

## 1. What `api-gateway` is responsible for

`api-gateway` is the "front door" for mobile clients.

It does 3 main jobs:

1. Authenticates users with **Privy access tokens**.
2. Accepts real-time client events over **WebSocket** and publishes them to **Kafka**.
3. Consumes Kafka events from other services and pushes updates back to connected users over WebSocket.

It also exposes these HTTP endpoints:

- `POST /auth/privy`
- `POST /payments/paystack/initialize`
- `GET /payments/paystack/verify`
- `POST /webhooks/paystack`
- `GET /health`

---

## 2. Why we use all three (Privy + Redis + Kafka)

### Privy (authentication)

Privy issues an access token after user login. The gateway verifies this token signature using `PRIVY_VERIFICATION_KEY`.

Meaning:

- We trust the user identity because Privy signed the token.
- We do not trust random client JSON saying "I am user X".

### Redis (live connection state)

WebSocket connections are temporary/live state. Redis stores routing state like:

- which users are online
- which gateway instance has sockets for a user

Why Redis is needed:

- If you run multiple gateway replicas, one replica may receive Kafka event but user socket may be on another replica.
- Redis Pub/Sub relays the message to the correct replica.

### Kafka (business event backbone)

Services do not call each other directly.

Instead:

- Gateway produces events like `RIDE_REQUESTED`, `GPS_UPDATE`, `USER_CREATED`.
- Other services consume and process.
- Those services emit new events like `RIDE_DRIVER_ASSIGNED`, `WALLET_CREDITED`.
- Gateway consumes those and pushes to client sockets.

Kafka gives loose coupling, scale, retries, and clear event contracts.

---

## 3. High-level architecture

```text
Mobile App
   |
   |  (HTTP + WebSocket)
   v
api-gateway
   |\
   | \-- Privy token verification (identity)
   |
   |-- Redis (who is connected where)
   |
   |-- Kafka Producer (client action -> event)
   |
   '-- Kafka Consumer (event -> client push)

Other services (ride-service, wallet-service, payment-service, ...)
   ^
   | (consume + produce)
   |
 Kafka
```

---

## 4. End-to-end flows

## Flow A: Login / registration

1. User logs in on mobile via Privy.
2. Mobile gets Privy access token.
3. Mobile calls `POST /auth/privy` with token.
4. Gateway verifies token (`iss`, `aud`, `exp`, signature).
5. Gateway finds user by Privy DID (`sub` claim).
6. If user does not exist, create user in DB and emit `USER_CREATED` on `user.events`.
7. Return user info to client.

Result: user identity is now trusted and known in backend.

## Flow B: WebSocket connection

1. Mobile opens WebSocket to `/ws` with bearer token.
2. Gateway verifies token with Privy.
3. Gateway loads user from DB and builds auth context.
4. Gateway registers socket in Redis-backed registry.

Result: gateway can now route real-time updates to this user.

## Flow C: Rider requests ride

1. Client sends WS message `ride:request`.
2. Gateway validates payload and emits `RIDE_REQUESTED` to Kafka.
3. `ride-service` consumes, matches driver, emits `RIDE_DRIVER_ASSIGNED`.
4. Gateway consumes that event and pushes `ride:matched` to rider socket.

Result: full async flow without direct service-to-service REST calls.

## Flow D: Wallet update push

1. `wallet-service` emits `WALLET_CREDITED` or `WALLET_DEBITED`.
2. Gateway Kafka consumer receives it.
3. Gateway routes `wallet:updated` to the user.
4. If socket is on another gateway instance, Redis Pub/Sub relays it.

Result: user gets live balance updates.

## Flow E: Payment webhooks

1. Paystack calls the webhook endpoint after a successful payment.
2. Gateway normalizes and validates payload.
3. Gateway emits payment event to Kafka (`payment.events`).
4. `payment-service` / `wallet-service` continue processing.

Result: external providers are integrated without coupling them to internal services.

---

## 5. What is stored where

- **Postgres**: durable domain data (users, wallets, rides, etc)
- **Redis**: live/transient routing/session info (online sockets + relay channels)
- **Kafka**: event log / inter-service communication
- **Privy**: auth authority (identity + signed tokens)

---

## 6. Producer vs consumer in this gateway

Gateway acts as **both**:

- **Producer** when client/webhook actions come in:
  - `user.events`
  - `driver.events`
  - `ride.events`
  - `gps.stream`
  - `payment.events`
  - `compliance.events`

- **Consumer** when backend services emit updates for clients:
  - `ride.events`
  - `wallet.events`
  - `notification.events`
  - `gps.processed`
  - `compliance.events`

---

## 7. Important env vars

Shared:

- `NODE_ENV`
- `DATABASE_URL`
- `KAFKA_BROKERS`
- `KAFKA_CLIENT_ID`
- `REDIS_URL`

Gateway specific:

- `PORT`
- `PRIVY_APP_ID`
- `PRIVY_APP_SECRET`
- `PRIVY_VERIFICATION_KEY`
- `CORS_ORIGINS`
- `WS_IDLE_TIMEOUT_MS`
- `JWT_SECRET` (legacy/optional)

---

## 8. Mental model to avoid confusion

When you are confused, ask this in order:

1. **Who is the user?** -> Privy token verification
2. **Where is the user connected?** -> Redis socket registry
3. **What business event happened?** -> Kafka event
4. **Who should react?** -> Kafka consumers (services + gateway)

If you follow those 4 questions, the system becomes much easier to reason about.
