import { z } from 'zod';

const BaseUserEvent = z.object({
  userId:    z.string().uuid(),
  timestamp: z.string().datetime(),
});

// Fired by api-gateway after Privy auth succeeds for a new user.
// Consumed by: wallet-service (create wallet), payment-service
// (prepare payment-side customer funding profile when needed),
// compliance-worker (log consent on-chain).
export const UserCreatedEvent = BaseUserEvent.extend({
  eventType:     z.literal('USER_CREATED'),
  privyDid:      z.string(),
  walletAddress: z.string().optional(),
  role:          z.enum(['RIDER', 'DRIVER', 'BOTH']),
  email:         z.string().email().optional(),
  name:          z.string().optional(),
  authMethod:    z.enum(['email', 'google', 'apple', 'wallet']),
});

// Fired by api-gateway when a previously wallet-less user later gets a linked wallet.
// Consumed by: wallet-service (create wallet row if missing), payment-service.
export const UserWalletLinkedEvent = BaseUserEvent.extend({
  eventType:     z.literal('USER_WALLET_LINKED'),
  privyDid:      z.string(),
  walletAddress: z.string(),
});

// Fired by compliance-worker after driver KYC docs are verified.
// Consumed by: ride-service (allow driver to accept rides),
// notification-worker (send approval push to driver).
export const UserKycApprovedEvent = BaseUserEvent.extend({
  eventType:     z.literal('USER_KYC_APPROVED'),
  walletAddress: z.string(),
  role:          z.literal('DRIVER'),
  approvedAt:    z.string().datetime(),
});

// Fired by api-gateway when user switches role in settings.
// Consumed by: ride-service (update driver eligibility cache).
export const UserRoleChangedEvent = BaseUserEvent.extend({
  eventType:  z.literal('USER_ROLE_CHANGED'),
  previousRole: z.enum(['RIDER', 'DRIVER', 'BOTH']),
  newRole:      z.enum(['RIDER', 'DRIVER', 'BOTH']),
});

// Fired by compliance-worker after recording consent is logged on-chain.
// Consumed by: ride-service (gate ride start on consent verified flag).
export const UserConsentLoggedEvent = BaseUserEvent.extend({
  eventType:      z.literal('USER_CONSENT_LOGGED'),
  walletAddress:  z.string(),
  consentType:    z.enum(['recording', 'defi_tier1', 'defi_tier2', 'defi_tier3']),
  consentTxHash:  z.string(),
  consentVersion: z.string(), // e.g. "v1.0" — bump when terms change
});

export const UserEvent = z.discriminatedUnion('eventType', [
  UserCreatedEvent,
  UserWalletLinkedEvent,
  UserKycApprovedEvent,
  UserRoleChangedEvent,
  UserConsentLoggedEvent,
]);

export type UserCreatedEvent      = z.infer<typeof UserCreatedEvent>;
export type UserWalletLinkedEvent = z.infer<typeof UserWalletLinkedEvent>;
export type UserKycApprovedEvent  = z.infer<typeof UserKycApprovedEvent>;
export type UserRoleChangedEvent  = z.infer<typeof UserRoleChangedEvent>;
export type UserConsentLoggedEvent = z.infer<typeof UserConsentLoggedEvent>;
export type UserEvent             = z.infer<typeof UserEvent>;
