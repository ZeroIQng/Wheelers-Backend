import { z } from 'zod';

const BaseWalletEvent = z.object({
  walletId:      z.string().uuid(),
  userId:        z.string().uuid(),
  walletAddress: z.string(),
  timestamp:     z.string().datetime(),
});

// Fired by wallet-service after any credit operation.
// Consumed by: api-gateway (push updated balance to user's WebSocket),
// defi-scheduler (check if new balance crosses idle threshold).
export const WalletCreditedEvent = BaseWalletEvent.extend({
  eventType:      z.literal('WALLET_CREDITED'),
  amountUsdt:     z.number(),
  newBalanceUsdt: z.number(),
  creditType:     z.enum([
    'ngn_deposit',
    'crypto_deposit',
    'driver_payout',
    'yield_harvest',
    'refund',
    'dispute_resolution',
  ]),
  referenceId: z.string(), // paymentId or rideId depending on creditType
});

// Fired by wallet-service after any debit operation.
// Consumed by: api-gateway (push updated balance to user's WebSocket).
export const WalletDebitedEvent = BaseWalletEvent.extend({
  eventType:      z.literal('WALLET_DEBITED'),
  amountUsdt:     z.number(),
  newBalanceUsdt: z.number(),
  debitType:      z.enum([
    'ride_payment',
    'penalty',
    'withdrawal',
    'defi_stake',
  ]),
  referenceId: z.string(),
});

// Fired by wallet-service when ride fare is held (before trip starts).
// Consumed by: api-gateway (show "funds reserved" in UI).
export const WalletLockedEvent = BaseWalletEvent.extend({
  eventType:        z.literal('WALLET_LOCKED'),
  lockedAmountUsdt: z.number(),
  rideId:           z.string().uuid(),
  reason:           z.literal('ride_fare_hold'),
});

// Fired by wallet-service after ride ends or dispute resolves.
// Consumed by: api-gateway (push balance update to WebSocket).
export const WalletUnlockedEvent = BaseWalletEvent.extend({
  eventType:          z.literal('WALLET_UNLOCKED'),
  unlockedAmountUsdt: z.number(),
  rideId:             z.string().uuid(),
  reason:             z.enum([
    'ride_completed',
    'ride_cancelled',
    'dispute_resolved',
  ]),
});

export const WalletEvent = z.discriminatedUnion('eventType', [
  WalletCreditedEvent,
  WalletDebitedEvent,
  WalletLockedEvent,
  WalletUnlockedEvent,
]);

export type WalletCreditedEvent  = z.infer<typeof WalletCreditedEvent>;
export type WalletDebitedEvent   = z.infer<typeof WalletDebitedEvent>;
export type WalletLockedEvent    = z.infer<typeof WalletLockedEvent>;
export type WalletUnlockedEvent  = z.infer<typeof WalletUnlockedEvent>;
export type WalletEvent          = z.infer<typeof WalletEvent>;