import { z } from 'zod';

const BaseDriverEvent = z.object({
  driverId:  z.string().uuid(),
  timestamp: z.string().datetime(),
});

// Fired by api-gateway when driver taps "Go online".
// Consumed by: ride-service (add to available driver pool in Redis).
export const DriverOnlineEvent = BaseDriverEvent.extend({
  eventType:     z.literal('DRIVER_ONLINE'),
  userId:        z.string().uuid(),
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
// Consumed by: compliance-worker (trigger manual review).
export const DriverKycSubmittedEvent = BaseDriverEvent.extend({
  eventType:       z.literal('DRIVER_KYC_SUBMITTED'),
  userId:          z.string().uuid(),
  licenceCid:      z.string(),
  selfieHash:      z.string(),
  vehicleMake:     z.string(),
  vehicleModel:    z.string(),
  vehiclePlate:    z.string(),
  vehicleYear:     z.number().int(),
  insuranceCid:    z.string(),
});

// Fired by compliance-worker after KYC is verified.
// Consumed by: notification-worker (send approval push).
export const DriverKycApprovedEvent = BaseDriverEvent.extend({
  eventType:    z.literal('DRIVER_KYC_APPROVED'),
  userId:       z.string().uuid(),
  reviewedBy:   z.string(),
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
