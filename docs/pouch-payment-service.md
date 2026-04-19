# Pouch Payment Service

This repo now uses Pouch as the single provider for fiat onramp and offramp orchestration.

## What changed

- `api-gateway` owns the authenticated Pouch HTTP surface.
- `payment-service` no longer converts NGN with Coinbase.
- `wallet-service` credits rider balances from `ONRAMP_SETTLED`.
- Paystack, Yellow Card, and Coinbase-specific funding code paths were removed.

## Gateway routes

- `GET /payments/pouch/health`
- `GET /payments/pouch/channels`
- `POST /payments/pouch/sessions`
- `GET /payments/pouch/sessions/:id`
- `GET /payments/pouch/sessions/:id/quote`
- `POST /payments/pouch/sessions/:id/identify`
- `POST /payments/pouch/sessions/:id/verify-otp`
- `GET /payments/pouch/sessions/:id/kyc-requirements`
- `POST /payments/pouch/sessions/:id/kyc`

## Event flow

1. Client creates a Pouch session through `api-gateway`.
2. Gateway attaches metadata containing the internal `userId` and `walletAddress`.
3. Client completes OTP and KYC via the Pouch session routes.
4. Client polls `GET /payments/pouch/sessions/:id`.
5. When the session reaches a settled state and the asset is wallet-creditable (`USDT` or `USDC`), the gateway emits `ONRAMP_SETTLED`.
6. `payment-service` records the settlement idempotently.
7. `wallet-service` credits the internal balance and emits `WALLET_CREDITED`.

## Why this scales better

- Provider orchestration stays at the edge in `api-gateway`.
- Internal services continue to react over Kafka instead of calling each other.
- Settlement idempotency remains in the payment persistence layer.
- New Pouch-supported rails and networks do not require a new internal event shape.

## Current wallet-credit rule

Internal wallet balances are still denominated in stablecoin. Automatic wallet credit currently happens only when Pouch settles into `USDT` or `USDC`. Other Pouch-supported assets can still be created as sessions, but they are not auto-credited into the existing single-asset wallet ledger without a broader wallet model change.
