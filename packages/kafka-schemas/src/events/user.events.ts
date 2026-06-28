import { z } from 'zod';

const BaseUserEvent = z.object({
  userId:    z.string().uuid(),
  timestamp: z.string().datetime(),
});

// Fired by api-gateway after local auth creates a new user.
// Consumed by: wallet-service (create wallet).
export const UserCreatedEvent = BaseUserEvent.extend({
  eventType:     z.literal('USER_CREATED'),
  privyDid:      z.string(),
  role:          z.enum(['RIDER', 'DRIVER', 'BOTH']),
  email:         z.string().email().optional(),
  name:          z.string().optional(),
  authMethod:    z.enum(['username']),
});

// Fired by compliance-worker after driver KYC docs are verified.
// Consumed by: ride-service (allow driver to accept rides),
// notification-worker (send approval push to driver).
export const UserKycApprovedEvent = BaseUserEvent.extend({
  eventType:     z.literal('USER_KYC_APPROVED'),
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

// Fired by compliance-worker after recording consent is logged.
// Consumed by: ride-service (gate ride start on consent verified flag).
export const UserConsentLoggedEvent = BaseUserEvent.extend({
  eventType:      z.literal('USER_CONSENT_LOGGED'),
  consentType:    z.enum(['recording']),
  consentVersion: z.string(),
});

// Fired by api-gateway after rider completes face liveness verification.
export const RiderKycVerifiedEvent = BaseUserEvent.extend({
  eventType:  z.literal('RIDER_KYC_VERIFIED'),
  verifiedAt: z.string().datetime(),
});

export const UserEvent = z.discriminatedUnion('eventType', [
  UserCreatedEvent,
  UserKycApprovedEvent,
  UserRoleChangedEvent,
  UserConsentLoggedEvent,
  RiderKycVerifiedEvent,
]);

export type UserCreatedEvent       = z.infer<typeof UserCreatedEvent>;
export type UserKycApprovedEvent   = z.infer<typeof UserKycApprovedEvent>;
export type UserRoleChangedEvent   = z.infer<typeof UserRoleChangedEvent>;
export type UserConsentLoggedEvent = z.infer<typeof UserConsentLoggedEvent>;
export type RiderKycVerifiedEvent  = z.infer<typeof RiderKycVerifiedEvent>;
export type UserEvent              = z.infer<typeof UserEvent>;
