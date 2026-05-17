# Pouch Payment Service

This repo now uses Pouch as the single provider for fiat onramp and offramp orchestration.

## What changed

- `api-gateway` owns the authenticated Pouch HTTP surface.
- Pouch shared-KYC direct ramp endpoints replaced the old session / OTP / KYC flow.
- Onramp settlement goes to a single env-configured master wallet.
- `wallet-service` credits rider balances from `ONRAMP_SETTLED`.
- `payment-service` and `wallet-service` keep the same event-driven settlement flow.

## Gateway routes

- `GET /payments/pouch/health`
- `POST /payments/pouch/onramp`
- `POST /payments/pouch/offramp`
- `GET /payments/pouch/status/:providerRef`

## Event flow

1. Client creates an onramp or offramp through `api-gateway`.
2. Gateway forces onramp settlement to `POUCH_MASTER_WALLET_ADDRESS` and stores internal ownership by `providerRef`.
3. Shared KYC is sent inline in the create request when required.
4. Client polls `GET /payments/pouch/status/:providerRef`.
5. Gateway emits `PAYMENT_SESSION_SYNCED` from the latest provider status.
6. When an onramp is settled into a wallet-creditable stablecoin (`USDT` or `USDC`), `payment-service` emits `ONRAMP_SETTLED`.
7. `wallet-service` credits the internal balance and emits `WALLET_CREDITED`.

## Why this scales better

- Provider orchestration stays at the edge in `api-gateway`.
- Internal services continue to react over Kafka instead of calling each other.
- Settlement idempotency remains in the payment persistence layer.
- New Pouch-supported rails and networks still map into the same internal event shape.

## Current wallet-credit rule

Internal wallet balances are still denominated in stablecoin. Automatic wallet credit currently happens only when Pouch settles into `USDT` or `USDC`. Other Pouch-supported assets can still be created as direct ramp transactions, but they are not auto-credited into the existing single-asset wallet ledger without a broader wallet model change.
