import { z } from 'zod';

const BaseDriverEvent = z.object({
  driverId:  z.string().uuid(),
  timestamp: z.string().datetime(),
});

// Fired by api-gateway when driver taps "Go online".
// Consumed by: ride-service (add to available driver pool in Redis).
export const DriverOnlineEvent = BaseDriverEvent.extend({
  eventType:     z.literal('DRIVER_ONLINE'),
  walletAddress: z.string(),
  lat:           z.number(),
  lng:           z.number(),
  vehiclePlate:  z.string(),
  vehicleModel:  z.string(),
});

// Fired by api-gateway when driver taps "Go offline" or app closes.
// Consumed by: ride-service (remove from available pool, cancel pending match).
export const DriverOfflineEvent = BaseDriverEvent.extend({
  eventType: z.literal('DRIVER_OFFLINE'),
  reason:    z.enum(['manual', 'app_closed', 'inactivity', 'admin']),
});

// Fired by api-gateway when driver submits KYC documents.
// Consumed by: compliance-worker (trigger manual review, store docs on IPFS).
export const DriverKycSubmittedEvent = BaseDriverEvent.extend({
  eventType:       z.literal('DRIVER_KYC_SUBMITTED'),
  userId:          z.string().uuid(),
  walletAddress:   z.string(),
  licenceCid:      z.string(),       // IPFS CID of licence image
  selfieHash:      z.string(),       // SHA-256 of face verification photo
  vehicleMake:     z.string(),
  vehicleModel:    z.string(),
  vehiclePlate:    z.string(),
  vehicleYear:     z.number().int(),
  insuranceCid:    z.string(),       // IPFS CID of insurance document
  consentTxHash:   z.string(),       // On-chain recording consent already logged
});

// Fired by compliance-worker after KYC is verified.
// Consumed by: notification-worker (send approval push).
// Note: USER_KYC_APPROVED on user.events is for ride-service eligibility,
// this event is specifically for the compliance audit trail.
export const DriverKycApprovedEvent = BaseDriverEvent.extend({
  eventType:    z.literal('DRIVER_KYC_APPROVED'),
  userId:       z.string().uuid(),
  reviewedBy:   z.string(),          // Admin user ID
  approvedAt:   z.string().datetime(),
});

// Fired by compliance-worker if KYC is rejected.
// Consumed by: notification-worker (send rejection push with reason).
export const DriverKycRejectedEvent = BaseDriverEvent.extend({
  eventType:  z.literal('DRIVER_KYC_REJECTED'),
  userId:     z.string().uuid(),
  reason:     z.string(),
  reviewedBy: z.string(),
});

export const DriverEvent = z.discriminatedUnion('eventType', [
  DriverOnlineEvent,
  DriverOfflineEvent,
  DriverKycSubmittedEvent,
  DriverKycApprovedEvent,
  DriverKycRejectedEvent,
]);

export type DriverOnlineEvent       = z.infer<typeof DriverOnlineEvent>;
export type DriverOfflineEvent      = z.infer<typeof DriverOfflineEvent>;
export type DriverKycSubmittedEvent = z.infer<typeof DriverKycSubmittedEvent>;
export type DriverKycApprovedEvent  = z.infer<typeof DriverKycApprovedEvent>;
export type DriverKycRejectedEvent  = z.infer<typeof DriverKycRejectedEvent>;
export type DriverEvent             = z.infer<typeof DriverEvent>;