import { z } from 'zod';

const BasePaymentEvent = z.object({
  userId:    z.string().uuid(),
  timestamp: z.string().datetime(),
});

// Fired by api-gateway webhook handler when a Pouch Liquifia virtual account
// receives a bank transfer deposit.
// Consumed by: wallet-service (credit user's internal NGN balance).
export const VirtualAccountCreditedEvent = BasePaymentEvent.extend({
  eventType:              z.literal('VIRTUAL_ACCOUNT_CREDITED'),
  pouchVirtualAccountId:  z.string(),
  amountNgn:              z.number(),
  bankName:               z.string().optional(),
  senderAccountNumber:    z.string().optional(),
  senderAccountName:      z.string().optional(),
  providerReference:      z.string(),
});

// Fired by api-gateway when a Pouch payout is created for a user withdrawal.
// Consumed by: payment-service (track payout lifecycle).
export const PayoutCreatedEvent = BasePaymentEvent.extend({
  eventType:         z.literal('PAYOUT_CREATED'),
  pouchPayoutId:     z.string(),
  withdrawalId:      z.string().uuid(),
  amountNgn:         z.number(),
  bankAccountNumber: z.string(),
  bankAccountName:   z.string(),
  bankNetworkId:     z.string(),
});

// Fired by webhook handler when Pouch confirms payout success.
// Consumed by: wallet-service (settle withdrawal, create transaction).
export const PayoutCompletedEvent = BasePaymentEvent.extend({
  eventType:          z.literal('PAYOUT_COMPLETED'),
  pouchPayoutId:      z.string(),
  providerReference:  z.string(),
  amountNgn:          z.number(),
});

// Fired by webhook handler when Pouch reports payout failure.
// Consumed by: wallet-service (release reserved funds back to user).
export const PayoutFailedEvent = BasePaymentEvent.extend({
  eventType:          z.literal('PAYOUT_FAILED'),
  pouchPayoutId:      z.string(),
  providerReference:  z.string(),
  failureReason:      z.string(),
});

export const PaymentEvent = z.discriminatedUnion('eventType', [
  VirtualAccountCreditedEvent,
  PayoutCreatedEvent,
  PayoutCompletedEvent,
  PayoutFailedEvent,
]);

export type VirtualAccountCreditedEvent = z.infer<typeof VirtualAccountCreditedEvent>;
export type PayoutCreatedEvent          = z.infer<typeof PayoutCreatedEvent>;
export type PayoutCompletedEvent        = z.infer<typeof PayoutCompletedEvent>;
export type PayoutFailedEvent           = z.infer<typeof PayoutFailedEvent>;
export type PaymentEvent                = z.infer<typeof PaymentEvent>;
