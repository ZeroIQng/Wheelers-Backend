# Paystack Payment Service

## What was implemented

The backend now treats Paystack as the fiat funding provider.

Current flow:

1. Frontend calls `POST /payments/paystack/initialize` with a Privy bearer token.
2. `api-gateway` verifies the user, creates a Paystack transaction reference, and returns `authorizationUrl`, `accessCode`, and the provider `reference`.
3. Frontend sends the user through Paystack checkout.
4. Paystack calls `POST /webhooks/paystack` on payment success.
5. `api-gateway` validates `x-paystack-signature`, normalizes the payload into `DEPOSIT_RECEIVED`, and publishes to Kafka.
6. `payment-service` consumes `DEPOSIT_RECEIVED`, applies idempotency checks, fetches a live NGN/USD rate from Coinbase, converts NGN to USDT on that basis, and emits `NGN_CONVERTING` then `NGN_CONVERTED`.
7. `wallet-service` consumes `NGN_CONVERTED` and credits the rider wallet ledger.
8. Gateway and workers can push wallet updates and notifications back to the client.

## Why payment, wallet, and ride stay separate

`payment-service` should not own balances.

Reason:

- Paystack tells you that money was paid.
- `payment-service` decides what funding event that payment means for the platform.
- `wallet-service` is the only place that should mutate `Wallet.balanceUsdt`, `lockedUsdt`, or the `Transaction` ledger.

`ride-service` should not call Paystack directly.

Reason:

- Ride logic should only care about whether the rider wallet has enough balance and when a ride is completed or cancelled.
- Payment provider failures should not leak into ride matching, GPS, or trip lifecycle logic.

## Frontend integration

### Rider funding flow

Use this sequence in the client:

1. User logs in with Privy and gets an access token.
2. Frontend calls `POST /payments/paystack/initialize`.
3. Request body:

```json
{
  "amountNgn": 5000,
  "email": "rider@example.com"
}
```

4. Backend response contains:

```json
{
  "provider": "paystack",
  "reference": "wheelers_...",
  "authorizationUrl": "https://checkout.paystack.com/...",
  "accessCode": "....",
  "publicKey": "pk_test_..."
}
```

5. Frontend opens `authorizationUrl` in a browser view or the Paystack-supported checkout surface.
6. After checkout returns, frontend calls `GET /payments/paystack/verify?reference=...` to display payment status.
7. Frontend then waits for wallet updates over WebSocket instead of directly crediting local state.

### What the rider app needs

- Funding screen
- Amount entry in NGN
- Email source for Paystack if Privy token does not carry email
- Payment status UI for `pending`, `success`, `failed`
- Wallet update listener over WebSocket

### What the driver app needs

Nothing Paystack-specific right now.

Reason:

- Drivers are paid from internal wallet settlement after `RIDE_COMPLETED`.
- Driver payout still comes from `payment-service -> DRIVER_PAYOUT -> wallet-service`.
- No driver-side Paystack integration is needed unless you later support fiat withdrawals to bank accounts.

## Service boundary answer

`wallet-service` and `ride-service` should not talk to Paystack.

The correct relationship is:

- `api-gateway` talks to Paystack for initialize, verify, and webhook edge traffic.
- `payment-service` interprets successful funding and emits payment domain events.
- `wallet-service` owns credits, debits, and ledger rows.
- `ride-service` owns matching, lifecycle, and fare-triggered events.

That means payment is isolated from ride execution, but not disconnected from it.

They communicate through Kafka events, not direct service-to-service calls.

## Open product decisions to confirm

1. Do you want Paystack only for rider cash-in, or also later for rider/driver bank withdrawals?
2. Do you want standard checkout only, or should we add dedicated virtual accounts as a second funding path?
3. Do you want to keep Coinbase as a quote-only FX source, or later replace it with a treasury/execution provider that can actually settle NGN into stablecoins?
4. Should frontend verify success purely from wallet WebSocket updates, or should it also show the Paystack verify result immediately after checkout?

## Test coverage added

Automated tests cover:

- Paystack signature verification
- Paystack metadata normalization
- Successful `charge.success` payload normalization into `DEPOSIT_RECEIVED`
- NGN to USDT conversion rounding and validation rules

Manual test flow:

1. Start Kafka, Postgres, and Redis.
2. Start `api-gateway`, `payment-service`, and `wallet-service`.
3. Authenticate a rider with `POST /auth/privy`.
4. Initialize Paystack with `POST /payments/paystack/initialize`.
5. Complete a Paystack test payment.
6. Confirm Paystack hits `POST /webhooks/paystack`.
7. Confirm `DEPOSIT_RECEIVED`, `NGN_CONVERTING`, and `NGN_CONVERTED` appear on `payment.events`.
8. Confirm `wallet-service` writes a `Transaction` with `referenceId = providerReference`.
9. Confirm frontend receives a wallet update event.
