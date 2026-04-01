import { z } from 'zod';

// Produced by api-gateway as raw pass-through from driver WebSocket.
// Consumed by: ride-service GPS processor (enriches and re-produces to gps.processed).
// High volume — 8 partitions, partitioned by driverId.
// Keep this schema minimal — it sits in the hottest path.
export const GpsUpdateEvent = z.object({
  eventType:   z.literal('GPS_UPDATE'),
  rideId:      z.string().uuid(),
  driverId:    z.string().uuid(),
  lat:         z.number(),
  lng:         z.number(),
  speedKmh:    z.number().optional(),
  headingDeg:  z.number().optional(), // 0-360, useful for map rotation
  accuracyM:   z.number().optional(), // GPS accuracy in metres
  timestamp:   z.string().datetime(),
});

// Produced by ride-service after computing distance delta and stale check.
// Consumed by: api-gateway (push to rider WebSocket for live map),
// compliance-worker (GPS_STALE_WARNING check runs here).
export const GpsProcessedEvent = z.object({
  eventType:        z.literal('GPS_PROCESSED'),
  rideId:           z.string().uuid(),
  driverId:         z.string().uuid(),
  lat:              z.number(),
  lng:              z.number(),
  speedKmh:         z.number().optional(),
  headingDeg:       z.number().optional(),
  distanceFromLastKm: z.number(),  // distance since previous GPS_UPDATE
  totalDistanceKm:  z.number(),    // cumulative for this ride
  isStale:          z.boolean(),   // true if <50m moved in last 5 minutes
  timestamp:        z.string().datetime(),
});

export type GpsUpdateEvent    = z.infer<typeof GpsUpdateEvent>;
export type GpsProcessedEvent = z.infer<typeof GpsProcessedEvent>;