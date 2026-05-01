import { z } from 'zod';

const BaseRideEvent = z.object({
  rideId:    z.string().uuid(),
  timestamp: z.string().datetime(),
});

const LatLng = z.object({
  lat:     z.number(),
  lng:     z.number(),
  address: z.string(),
});

const RideStopSnapshot = LatLng.extend({
  stopId: z.string().uuid(),
  stopOrder: z.number().int().nonnegative(),
  type: z.enum(['intermediate', 'final']),
  status: z.enum(['pending', 'completed', 'skipped']),
  completedAt: z.string().datetime().optional(),
});

// Fired by api-gateway when rider submits a ride request via WebSocket.
// Consumed by: ride-service (begin driver matching).
export const RideRequestedEvent = BaseRideEvent.extend({
  eventType:        z.literal('RIDE_REQUESTED'),
  riderId:          z.string().uuid(),
  riderWallet:      z.string(),
  pickup:           LatLng,
  destination:      LatLng,
  stops:            z.array(LatLng).max(5).default([]),
  fareEstimateUsdt: z.number(),
  paymentMethod:    z.enum(['wallet_balance', 'smart_account']),
});

export const RideRouteUpdateRequestedEvent = BaseRideEvent.extend({
  eventType:        z.literal('RIDE_ROUTE_UPDATE_REQUESTED'),
  riderId:          z.string().uuid(),
  driverId:         z.string().uuid().optional(),
  destination:      LatLng,
  stops:            z.array(LatLng).max(5).default([]),
  fareEstimateUsdt: z.number().optional(),
  updatedBy:        z.enum(['rider', 'driver', 'system']),
});

export const RideStopConfirmedEvent = BaseRideEvent.extend({
  eventType:   z.literal('RIDE_STOP_CONFIRMED'),
  riderId:     z.string().uuid(),
  driverId:    z.string().uuid(),
  confirmedBy: z.enum(['driver', 'rider']).default('driver'),
});

// Fired by ride-service after a driver is matched and accepts.
// Consumed by: wallet-service (lock ride fare in rider wallet),
// notification-worker (push to rider), api-gateway (push to rider WebSocket).
export const RideDriverAssignedEvent = BaseRideEvent.extend({
  eventType:    z.literal('RIDE_DRIVER_ASSIGNED'),
  riderId:      z.string().uuid(),
  driverId:     z.string().uuid(),
  driverWallet: z.string(),
  driverName:   z.string(),
  driverRating: z.number(),
  vehiclePlate: z.string(),
  vehicleModel: z.string(),
  etaSeconds:   z.number().int(),
  lockedFareUsdt: z.number(),
});

export const RideRouteUpdatedEvent = BaseRideEvent.extend({
  eventType:        z.literal('RIDE_ROUTE_UPDATED'),
  riderId:          z.string().uuid(),
  driverId:         z.string().uuid().optional(),
  destination:      LatLng,
  stops:            z.array(RideStopSnapshot),
  fareEstimateUsdt: z.number().optional(),
  updatedBy:        z.enum(['rider', 'driver', 'system']),
});

// Fired by api-gateway when both rider and driver confirm pickup.
// Consumed by: compliance-worker (verify consent, begin recording if enabled),
// ride-service (start GPS stale detection cron for this rideId).
export const RideStartedEvent = BaseRideEvent.extend({
  eventType:                z.literal('RIDE_STARTED'),
  riderId:                  z.string().uuid(),
  driverId:                 z.string().uuid(),
  riderWallet:              z.string(),
  driverWallet:             z.string(),
  lockedFareUsdt:           z.number(),
  recordingConsentVerified: z.boolean(),
  recordingId:              z.string().uuid().optional(), // set if recording started
  startedAt:                z.string().datetime(),
});

export const RideCompletionRequestedEvent = BaseRideEvent.extend({
  eventType:    z.literal('RIDE_COMPLETION_REQUESTED'),
  riderId:      z.string().uuid(),
  driverId:     z.string().uuid(),
  riderWallet:  z.string(),
  driverWallet: z.string(),
  fareUsdt:     z.number().optional(),
  recordingCid: z.string().optional(),
  recordingHash: z.string().optional(),
  endedBy:      z.enum(['both_confirmed', 'auto_gps', 'admin']),
  completedAt:  z.string().datetime().optional(),
});

// Fired by ride-service when both parties end the trip (or auto-end triggers).
// Consumed by: payment-service (calculate and emit DRIVER_PAYOUT),
// wallet-service (unlock rider funds, debit final fare),
// compliance-worker (finalise recording, log on-chain receipt),
// notification-worker (completion push to both),
// defi-scheduler (check rider idle balance after debit).
export const RideCompletedEvent = BaseRideEvent.extend({
  eventType:       z.literal('RIDE_COMPLETED'),
  riderId:         z.string().uuid(),
  driverId:        z.string().uuid(),
  riderWallet:     z.string(),
  driverWallet:    z.string(),
  fareUsdt:        z.number(),
  distanceKm:      z.number(),
  durationSeconds: z.number().int(),
  recordingCid:    z.string().optional(),   // IPFS CID if recorded
  recordingHash:   z.string().optional(),   // SHA-256 for on-chain log
  endedBy:         z.enum(['both_confirmed', 'auto_gps', 'admin']),
  completedAt:     z.string().datetime(),
});

// Fired by api-gateway when rider cancels.
// Stage determines penalty tier.
// Consumed by: payment-service (apply penalty if stage warrants),
// wallet-service (unlock fare hold), ride-service (free driver),
// notification-worker (push to driver).
export const RideCancelledEvent = BaseRideEvent.extend({
  eventType:    z.literal('RIDE_CANCELLED'),
  riderId:      z.string().uuid(),
  driverId:     z.string().uuid().optional(), // not set if cancelled before match
  riderWallet:  z.string(),
  driverWallet: z.string().optional(),
  cancelStage:  z.enum([
    'before_match',       // no penalty
    'after_match',        // small penalty
    'driver_en_route',    // medium penalty
    'active_trip',        // high penalty
  ]),
  penaltyUsdt:  z.number(),                  // 0 if before_match
  reason:       z.string().optional(),
});

// Fired by ride-service when driver explicitly rejects a ride request.
// Consumed by: ride-service itself (try next nearest driver), 
// notification-worker (silent — no push needed for this).
export const RideDriverRejectedEvent = BaseRideEvent.extend({
  eventType:  z.literal('RIDE_DRIVER_REJECTED'),
  riderId:    z.string().uuid(),
  driverId:   z.string().uuid(),
  reason:     z.enum(['timeout', 'manual_reject']),
});

export const RideEvent = z.discriminatedUnion('eventType', [
  RideRequestedEvent,
  RideRouteUpdateRequestedEvent,
  RideStopConfirmedEvent,
  RideDriverAssignedEvent,
  RideRouteUpdatedEvent,
  RideStartedEvent,
  RideCompletionRequestedEvent,
  RideCompletedEvent,
  RideCancelledEvent,
  RideDriverRejectedEvent,
]);

export type RideRequestedEvent       = z.infer<typeof RideRequestedEvent>;
export type RideRouteUpdateRequestedEvent = z.infer<typeof RideRouteUpdateRequestedEvent>;
export type RideStopConfirmedEvent   = z.infer<typeof RideStopConfirmedEvent>;
export type RideDriverAssignedEvent  = z.infer<typeof RideDriverAssignedEvent>;
export type RideRouteUpdatedEvent    = z.infer<typeof RideRouteUpdatedEvent>;
export type RideStartedEvent         = z.infer<typeof RideStartedEvent>;
export type RideCompletionRequestedEvent = z.infer<typeof RideCompletionRequestedEvent>;
export type RideCompletedEvent       = z.infer<typeof RideCompletedEvent>;
export type RideCancelledEvent       = z.infer<typeof RideCancelledEvent>;
export type RideDriverRejectedEvent  = z.infer<typeof RideDriverRejectedEvent>;
export type RideEvent                = z.infer<typeof RideEvent>;
