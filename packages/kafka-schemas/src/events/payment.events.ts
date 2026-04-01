import { z } from 'zod';

const BasePaymentEvent = z.object({
  paymentId: z.string().uuid(),
  userId:    z.string().uuid(),
  timestamp: z.string().datetime(),
});

// Fired by payment-service when Korapay webhook arrives.
// Consumed by: payment-service itself (trigger YellowCard conversion —
// produces to its own topic to decouple webhook response from swap time).
export const DepositReceivedEvent = BasePaymentEvent.extend({
  eventType:             z.literal('DEPOSIT_RECEIVED'),
  amountNgn:             z.number(),
  korapayReference:      z.string(),
  virtualAccountNumber:  z.string(),
  userWallet:            z.string(),
});

// Fired by payment-service immediately after calling YellowCard API.
// Consumed by: notification-worker (push "converting..." status to rider).
export const NgnConvertingEvent = BasePaymentEvent.extend({
  eventType:       z.literal('NGN_CONVERTING'),
  amountNgn:       z.number(),
  estimatedUsdt:   z.number(),
  yellowcardJobId: z.string(),
});

// Fired by payment-service when YellowCard confirms the swap completed.
// Consumed by: wallet-service (credit USDT balance),
// notification-worker (push "wallet funded" to rider).
export const NgnConvertedEvent = BasePaymentEvent.extend({
  eventType:            z.literal('NGN_CONVERTED'),
  amountNgn:            z.number(),
  amountUsdt:           z.number(),
  exchangeRate:         z.number(),
  userWallet:           z.string(),
  yellowcardReference:  z.string(),
});

// Fired by payment-service after fare is calculated post ride-completion.
// Fee is only applied when driverProfitUsdt > 0 (we never charge on a loss).
// Consumed by: wallet-service (credit driver wallet),
// compliance-worker (log payout on-chain),
// notification-worker (push earnings summary to driver).
export const DriverPayoutEvent = BasePaymentEvent.extend({
  eventType:        z.literal('DRIVER_PAYOUT'),
  rideId:           z.string().uuid(),
  driverId:         z.string().uuid(),
  driverWallet:     z.string(),
  grossFareUsdt:    z.number(),
  driverCostsUsdt:  z.number(),    // fuel, tolls etc if tracked — 0 initially
  driverProfitUsdt: z.number(),    // grossFare - driverCosts
  platformFeeUsdt:  z.number(),    // 0.3% of profit, 0 if profit <= 0
  netPayoutUsdt:    z.number(),    // what driver actually receives
  feeApplied:       z.boolean(),
});

// Fired by payment-service after applying a cancellation penalty.
// Consumed by: wallet-service (debit rider wallet),
// notification-worker (push penalty notice to rider).
export const PenaltyAppliedEvent = BasePaymentEvent.extend({
  eventType:    z.literal('PENALTY_APPLIED'),
  rideId:       z.string().uuid(),
  riderWallet:  z.string(),
  penaltyUsdt:  z.number(),
  reason:       z.enum([
    'rider_cancel_after_match',
    'rider_cancel_en_route',
    'rider_cancel_active_trip',
    'no_show',
  ]),
});

// Fired by payment-service when a crypto deposit is detected on-chain.
// Consumed by: wallet-service (credit USDT balance directly — no conversion needed),
// notification-worker (push "crypto deposit received" to user).
export const CryptoDepositReceivedEvent = BasePaymentEvent.extend({
  eventType:    z.literal('CRYPTO_DEPOSIT_RECEIVED'),
  userWallet:   z.string(),
  amountUsdt:   z.number(),
  txHash:       z.string(),
  chainId:      z.number().int(),
  fromAddress:  z.string(),
});

export const PaymentEvent = z.discriminatedUnion('eventType', [
  DepositReceivedEvent,
  NgnConvertingEvent,
  NgnConvertedEvent,
  DriverPayoutEvent,
  PenaltyAppliedEvent,
  CryptoDepositReceivedEvent,
]);

export type DepositReceivedEvent       = z.infer<typeof DepositReceivedEvent>;
export type NgnConvertingEvent         = z.infer<typeof NgnConvertingEvent>;
export type NgnConvertedEvent          = z.infer<typeof NgnConvertedEvent>;
export type DriverPayoutEvent          = z.infer<typeof DriverPayoutEvent>;
export type PenaltyAppliedEvent        = z.infer<typeof PenaltyAppliedEvent>;
export type CryptoDepositReceivedEvent = z.infer<typeof CryptoDepositReceivedEvent>;
export type PaymentEvent               = z.infer<typeof PaymentEvent>;