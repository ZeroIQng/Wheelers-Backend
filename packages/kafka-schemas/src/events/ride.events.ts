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

const RouteCoordinate = z.object({
  lat: z.number(),
  lng: z.number(),
});

const RouteBounds = z.object({
  northEast: RouteCoordinate,
  southWest: RouteCoordinate,
});

const RouteGeometry = z.object({
  coordinates: z.array(RouteCoordinate).min(2),
  bounds: RouteBounds,
});

const RideStopSnapshot = LatLng.extend({
  stopId: z.string().uuid(),
  stopOrder: z.number().int().nonnegative(),
  type: z.enum(['intermediate', 'final']),
  status: z.enum(['pending', 'completed', 'skipped']),
  completedAt: z.string().datetime().optional(),
});

const PaymentMethod = z.enum(['CASH', 'WALLET']);

// Fired by api-gateway when rider submits a ride request via WebSocket.
// Consumed by: ride-service (broadcast to nearby drivers for bidding).
export const RideRequestedEvent = BaseRideEvent.extend({
  eventType:        z.literal('RIDE_REQUESTED'),
  riderId:          z.string().uuid(),
  pickup:           LatLng,
  destination:      LatLng,
  stops:            z.array(LatLng).max(5).default([]),
  plannedDistanceKm: z.number().optional(),
  plannedDurationSeconds: z.number().int().optional(),
  fareEstimateNgn:  z.number(),
  paymentMethod:    PaymentMethod,
  riderOfferNgn:    z.number(),
  suggestedFareNgn: z.number(),
  minOfferNgn:      z.number(),
  ratePerKmNgn:     z.number(),
  fareBeforeCashbackNgn: z.number().optional(),
  referralCashbackAppliedNgn: z.number().optional(),
  route:            RouteGeometry.optional(),
});

export const RideRouteUpdateRequestedEvent = BaseRideEvent.extend({
  eventType:        z.literal('RIDE_ROUTE_UPDATE_REQUESTED'),
  riderId:          z.string().uuid(),
  driverId:         z.string().uuid().optional(),
  destination:      LatLng,
  stops:            z.array(LatLng).max(5).default([]),
  plannedDistanceKm: z.number().optional(),
  plannedDurationSeconds: z.number().int().optional(),
  fareEstimateNgn:  z.number().optional(),
  route:            RouteGeometry.optional(),
  updatedBy:        z.enum(['rider', 'driver', 'system']),
});

export const RideStopConfirmedEvent = BaseRideEvent.extend({
  eventType:   z.literal('RIDE_STOP_CONFIRMED'),
  riderId:     z.string().uuid(),
  driverId:    z.string().uuid(),
  confirmedBy: z.enum(['driver', 'rider']).default('driver'),
});

// Fired by ride-service after broadcasting ride to nearby drivers.
// Consumed by: api-gateway (push to driver via WebSocket as ride:offer).
export const RideOfferSentEvent = BaseRideEvent.extend({
  eventType:             z.literal('RIDE_OFFER_SENT'),
  riderId:               z.string().uuid(),
  driverId:              z.string().uuid(),
  driverUserId:          z.string().uuid(),
  pickup:                LatLng,
  destination:           LatLng,
  stops:                 z.array(LatLng).max(5).default([]),
  fareEstimateNgn:       z.number(),
  paymentMethod:         PaymentMethod,
  riderOfferNgn:         z.number(),
  suggestedFareNgn:      z.number(),
  ratePerKmNgn:          z.number(),
  plannedDistanceKm:     z.number().optional(),
  plannedDurationSeconds: z.number().int().optional(),
  expiresAt:             z.string().datetime(),
  route:                 RouteGeometry.optional(),
});

// Fired by api-gateway when driver sends a counter-offer via WebSocket.
// Consumed by: ride-service (store bid), api-gateway (forward to rider).
export const RideCounterOfferEvent = BaseRideEvent.extend({
  eventType:        z.literal('RIDE_COUNTER_OFFER'),
  riderId:          z.string().uuid(),
  driverId:         z.string().uuid(),
  driverUserId:     z.string().uuid(),
  counterOfferNgn:  z.number(),
  driverName:       z.string(),
  driverRating:     z.number(),
  vehiclePlate:     z.string(),
  vehicleModel:     z.string(),
  etaSeconds:       z.number().int(),
});

// Fired by api-gateway when rider picks a driver's offer via WebSocket.
// Consumed by: ride-service (publish RIDE_DRIVER_ASSIGNED, clean up bids).
export const RideOfferAcceptedEvent = BaseRideEvent.extend({
  eventType:      z.literal('RIDE_OFFER_ACCEPTED'),
  riderId:        z.string().uuid(),
  driverId:       z.string().uuid(),
  driverUserId:   z.string().uuid(),
  agreedFareNgn:  z.number(),
  paymentMethod:  PaymentMethod,
});

// Fired by ride-service after rider accepts a driver's bid.
// Consumed by: wallet-service (lock ride fare in rider wallet if WALLET),
// notification-worker (push to rider), api-gateway (push to rider WebSocket).
export const RideDriverAssignedEvent = BaseRideEvent.extend({
  eventType:      z.literal('RIDE_DRIVER_ASSIGNED'),
  riderId:        z.string().uuid(),
  driverId:       z.string().uuid(),
  driverUserId:   z.string().uuid(),
  driverName:     z.string(),
  driverRating:   z.number(),
  vehiclePlate:   z.string(),
  vehicleModel:   z.string(),
  etaSeconds:     z.number().int(),
  agreedFareNgn:  z.number(),
  lockedFareNgn:  z.number(),
  paymentMethod:  PaymentMethod,
});

export const RideRouteUpdatedEvent = BaseRideEvent.extend({
  eventType:        z.literal('RIDE_ROUTE_UPDATED'),
  riderId:          z.string().uuid(),
  driverId:         z.string().uuid().optional(),
  destination:      LatLng,
  stops:            z.array(RideStopSnapshot),
  plannedDistanceKm: z.number().optional(),
  plannedDurationSeconds: z.number().int().optional(),
  fareEstimateNgn:  z.number().optional(),
  route:            RouteGeometry.optional(),
  updatedBy:        z.enum(['rider', 'driver', 'system']),
});

// Fired by api-gateway when both rider and driver confirm pickup.
// Consumed by: ride-service (start GPS stale detection cron for this rideId).
export const RideStartedEvent = BaseRideEvent.extend({
  eventType:     z.literal('RIDE_STARTED'),
  riderId:       z.string().uuid(),
  driverId:      z.string().uuid(),
  lockedFareNgn: z.number(),
  paymentMethod: PaymentMethod,
  startedAt:     z.string().datetime(),
});

export const RideCompletionRequestedEvent = BaseRideEvent.extend({
  eventType:    z.literal('RIDE_COMPLETION_REQUESTED'),
  riderId:      z.string().uuid(),
  driverId:     z.string().uuid(),
  fareNgn:      z.number().optional(),
  endedBy:      z.enum(['both_confirmed', 'auto_gps', 'admin']),
  completedAt:  z.string().datetime().optional(),
});

// Fired by ride-service when both parties end the trip (or auto-end triggers).
// Consumed by: wallet-service (unlock rider funds, debit final fare, credit driver),
// notification-worker (completion push to both).
export const RideCompletedEvent = BaseRideEvent.extend({
  eventType:       z.literal('RIDE_COMPLETED'),
  riderId:         z.string().uuid(),
  driverId:        z.string().uuid(),
  driverUserId:    z.string().uuid(),
  fareNgn:         z.number(),
  distanceKm:      z.number(),
  durationSeconds: z.number().int(),
  endedBy:         z.enum(['both_confirmed', 'auto_gps', 'admin']),
  completedAt:     z.string().datetime(),
  paymentMethod:   PaymentMethod,
});

// Fired by api-gateway when rider cancels.
// Consumed by: wallet-service (unlock fare hold), ride-service (free driver),
// notification-worker (push to driver).
export const RideCancelledEvent = BaseRideEvent.extend({
  eventType:    z.literal('RIDE_CANCELLED'),
  riderId:      z.string().uuid(),
  driverId:     z.string().uuid().optional(),
  reason:       z.string().optional(),
});

// Fired by ride-service when it offers a ride to a specific driver.
// Consumed by: api-gateway (relay to driver via WebSocket as ride:offer).
export const RideDriverRejectedEvent = BaseRideEvent.extend({
  eventType:  z.literal('RIDE_DRIVER_REJECTED'),
  riderId:    z.string().uuid(),
  driverId:   z.string().uuid(),
  reason:     z.enum(['timeout', 'manual_reject']),
});

// Fired by ride-service after 3 minutes with no counter-offers.
// Consumed by: api-gateway (relay to rider as ride:bid_timeout).
export const RideBidTimeoutEvent = BaseRideEvent.extend({
  eventType: z.literal('RIDE_BID_TIMEOUT'),
  riderId:   z.string().uuid(),
});

// Fired by api-gateway when a rider or driver sends a chat message during a ride.
// Consumed by: api-gateway (relay to both rider and driver via WebSocket as chat:message).
export const ChatMessageSentEvent = BaseRideEvent.extend({
  eventType:  z.literal('CHAT_MESSAGE_SENT'),
  messageId:  z.string().uuid(),
  senderId:   z.string().uuid(),
  senderRole: z.enum(['RIDER', 'DRIVER']),
  content:    z.string().min(1).max(1000),
});

export const RideEvent = z.discriminatedUnion('eventType', [
  RideRequestedEvent,
  RideRouteUpdateRequestedEvent,
  RideStopConfirmedEvent,
  RideOfferSentEvent,
  RideCounterOfferEvent,
  RideOfferAcceptedEvent,
  RideDriverAssignedEvent,
  RideRouteUpdatedEvent,
  RideStartedEvent,
  RideCompletionRequestedEvent,
  RideCompletedEvent,
  RideCancelledEvent,
  RideDriverRejectedEvent,
  RideBidTimeoutEvent,
  ChatMessageSentEvent,
]);

export type RideRequestedEvent       = z.infer<typeof RideRequestedEvent>;
export type RideRouteUpdateRequestedEvent = z.infer<typeof RideRouteUpdateRequestedEvent>;
export type RideStopConfirmedEvent   = z.infer<typeof RideStopConfirmedEvent>;
export type RideOfferSentEvent       = z.infer<typeof RideOfferSentEvent>;
export type RideCounterOfferEvent    = z.infer<typeof RideCounterOfferEvent>;
export type RideOfferAcceptedEvent   = z.infer<typeof RideOfferAcceptedEvent>;
export type RideDriverAssignedEvent  = z.infer<typeof RideDriverAssignedEvent>;
export type RideRouteUpdatedEvent    = z.infer<typeof RideRouteUpdatedEvent>;
export type RideStartedEvent         = z.infer<typeof RideStartedEvent>;
export type RideCompletionRequestedEvent = z.infer<typeof RideCompletionRequestedEvent>;
export type RideCompletedEvent       = z.infer<typeof RideCompletedEvent>;
export type RideCancelledEvent       = z.infer<typeof RideCancelledEvent>;
export type RideDriverRejectedEvent  = z.infer<typeof RideDriverRejectedEvent>;
export type RideBidTimeoutEvent      = z.infer<typeof RideBidTimeoutEvent>;
export type ChatMessageSentEvent     = z.infer<typeof ChatMessageSentEvent>;
export type RideEvent                = z.infer<typeof RideEvent>;
