import { z } from 'zod';

const BasePaymentEvent = z.object({
  paymentId: z.string().uuid(),
  userId:    z.string().uuid(),
  timestamp: z.string().datetime(),
});

const PaymentProvider = z.enum(['pouch']);
const PaymentSessionType = z.enum(['ONRAMP', 'OFFRAMP']);

// Fired by api-gateway after an authenticated user opens a Pouch payment session.
// Consumed by: payment-service (audit trail / reconciliation), notification-worker.
export const PaymentSessionCreatedEvent = BasePaymentEvent.extend({
  eventType:            z.literal('PAYMENT_SESSION_CREATED'),
  paymentProvider:      PaymentProvider,
  providerReference:    z.string(),
  sessionType:          PaymentSessionType,
  status:               z.string(),
  amountUsd:            z.number(),
  localCurrency:        z.string(),
  amountLocal:          z.number().optional(),
  cryptoCurrency:       z.string(),
  cryptoNetwork:        z.string(),
  chain:                z.string().optional(),
  customerEmail:        z.string().email().optional(),
  userWallet:           z.string(),
  walletTag:            z.string().optional(),
});

// Fired by api-gateway when it fetches the latest Pouch session state.
// Consumed by: payment-service, which owns settlement decisioning.
export const PaymentSessionSyncedEvent = BasePaymentEvent.extend({
  eventType:            z.literal('PAYMENT_SESSION_SYNCED'),
  paymentProvider:      PaymentProvider,
  providerReference:    z.string(),
  sessionType:          PaymentSessionType,
  status:               z.string(),
  amountUsd:            z.number(),
  localCurrency:        z.string(),
  amountLocal:          z.number().optional(),
  cryptoCurrency:       z.string(),
  cryptoNetwork:        z.string(),
  cryptoAmount:         z.number().optional(),
  chain:                z.string().optional(),
  customerEmail:        z.string().email().optional(),
  userWallet:           z.string(),
  walletTag:            z.string().optional(),
  settlementReference:  z.string().optional(),
});

// Fired by payment-service when a synced Pouch onramp is determined to be settled.
// Consumed by: wallet-service (credit internal stablecoin balance), notification-worker.
export const OnrampSettledEvent = BasePaymentEvent.extend({
  eventType:            z.literal('ONRAMP_SETTLED'),
  paymentProvider:      PaymentProvider,
  providerReference:    z.string(),
  amountUsd:            z.number(),
  localCurrency:        z.string(),
  amountLocal:          z.number().optional(),
  amountUsdt:           z.number(),
  cryptoCurrency:       z.string(),
  cryptoNetwork:        z.string(),
  chain:                z.string().optional(),
  userWallet:           z.string(),
  settlementReference:  z.string().optional(),
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
  PaymentSessionCreatedEvent,
  PaymentSessionSyncedEvent,
  OnrampSettledEvent,
  CryptoDepositReceivedEvent,
]);

export type PaymentSessionCreatedEvent = z.infer<typeof PaymentSessionCreatedEvent>;
export type PaymentSessionSyncedEvent  = z.infer<typeof PaymentSessionSyncedEvent>;
export type OnrampSettledEvent         = z.infer<typeof OnrampSettledEvent>;
export type CryptoDepositReceivedEvent = z.infer<typeof CryptoDepositReceivedEvent>;
export type PaymentEvent               = z.infer<typeof PaymentEvent>;
