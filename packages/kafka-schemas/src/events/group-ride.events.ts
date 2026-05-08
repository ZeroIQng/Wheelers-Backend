import { z } from 'zod';

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

const LatLng = z.object({
  lat: z.number(),
  lng: z.number(),
  address: z.string(),
});

const BaseGroupRideEvent = z.object({
  groupId: z.string().uuid(),
  timestamp: z.string().datetime(),
});

const GroupRideMember = z.object({
  rideId: z.string().uuid(),
  riderId: z.string().uuid(),
  pickup: LatLng,
  destination: LatLng,
  headingDeg: z.number(),
  compatibilityScore: z.number().min(0).max(1),
});

const GroupRideStop = LatLng.extend({
  rideId: z.string().uuid(),
  riderId: z.string().uuid(),
  sequence: z.number().int().nonnegative(),
  kind: z.enum(['pickup', 'dropoff']),
});

const GroupRideLeg = z.object({
  fromSequence: z.number().int().nonnegative(),
  toSequence: z.number().int().nonnegative(),
  distanceKm: z.number().nonnegative(),
  durationSeconds: z.number().int().nonnegative(),
  route: RouteGeometry,
});

export const GroupRideCandidatesIdentifiedEvent = BaseGroupRideEvent.extend({
  eventType: z.literal('GROUP_RIDE_CANDIDATES_IDENTIFIED'),
  anchorRideId: z.string().uuid(),
  rideIds: z.array(z.string().uuid()).min(2),
  members: z.array(GroupRideMember).min(2),
  searchRadiusKm: z.number().positive(),
  maxBearingDeltaDeg: z.number().positive(),
});

export const GroupRidePlannedEvent = BaseGroupRideEvent.extend({
  eventType: z.literal('GROUP_RIDE_PLANNED'),
  anchorRideId: z.string().uuid(),
  rideIds: z.array(z.string().uuid()).min(2),
  riderIds: z.array(z.string().uuid()).min(2),
  stops: z.array(GroupRideStop).min(4),
  heuristicDistanceKm: z.number().nonnegative(),
  sequenceAlgorithm: z.enum(['dp_precedence', 'greedy_nearest_neighbour']),
});

export const GroupRideRouteBuiltEvent = BaseGroupRideEvent.extend({
  eventType: z.literal('GROUP_RIDE_ROUTE_BUILT'),
  anchorRideId: z.string().uuid(),
  rideIds: z.array(z.string().uuid()).min(2),
  riderIds: z.array(z.string().uuid()).min(2),
  stops: z.array(GroupRideStop).min(4),
  legs: z.array(GroupRideLeg).min(1),
  totalDistanceKm: z.number().nonnegative(),
  totalDurationSeconds: z.number().int().nonnegative(),
  route: RouteGeometry,
  routeAlgorithm: z.enum(['google_routes_segments']),
});

export const GroupRideEvent = z.discriminatedUnion('eventType', [
  GroupRideCandidatesIdentifiedEvent,
  GroupRidePlannedEvent,
  GroupRideRouteBuiltEvent,
]);

export type GroupRideCandidatesIdentifiedEvent = z.infer<typeof GroupRideCandidatesIdentifiedEvent>;
export type GroupRidePlannedEvent = z.infer<typeof GroupRidePlannedEvent>;
export type GroupRideRouteBuiltEvent = z.infer<typeof GroupRideRouteBuiltEvent>;
export type GroupRideEvent = z.infer<typeof GroupRideEvent>;
