import { groupRideClient } from '@wheleers/db';
import { haversineKm } from '../utils/geo';

/**
 * Same corridor gates the group-ride matcher itself uses
 * (apps/group-ride/src/algorithms/knn.ts) — pickup radius, destination
 * radius, heading delta — so a suggestion is only made when the matcher
 * would actually consider grouping these riders.
 */
const PICKUP_RADIUS_KM = Number(process.env['GROUP_RIDE_PICKUP_RADIUS_KM'] ?? 2.5);
const DESTINATION_RADIUS_KM = Number(process.env['GROUP_RIDE_DESTINATION_RADIUS_KM'] ?? 6);
const BEARING_THRESHOLD_DEG = Number(process.env['GROUP_RIDE_BEARING_THRESHOLD_DEG'] ?? 35);
const SUGGEST_MIN_MATCHES = Number(process.env['GROUP_RIDE_SUGGEST_MIN_MATCHES'] ?? 1);

export interface GroupRideSuggestion {
  count: number;
  sampleDestination: string;
}

function bearingDegrees(
  from: { lat: number; lng: number },
  to: { lat: number; lng: number },
): number {
  const toRad = (n: number) => (n * Math.PI) / 180;
  const dLng = toRad(to.lng - from.lng);
  const y = Math.sin(dLng) * Math.cos(toRad(to.lat));
  const x =
    Math.cos(toRad(from.lat)) * Math.sin(toRad(to.lat)) -
    Math.sin(toRad(from.lat)) * Math.cos(toRad(to.lat)) * Math.cos(dLng);
  const deg = (Math.atan2(y, x) * 180) / Math.PI;
  return (deg + 360) % 360;
}

function headingDeltaDegrees(a: number, b: number): number {
  const diff = Math.abs(a - b) % 360;
  return diff > 180 ? 360 - diff : diff;
}

/**
 * Every normal booking is a potential group ride: check the open match-request
 * pool for riders already heading the same corridor. Never throws — a
 * suggestion failure must not touch the booking.
 */
export async function findGroupRideSuggestion(
  riderId: string,
  pickup: { lat: number; lng: number },
  destination: { lat: number; lng: number },
): Promise<GroupRideSuggestion | null> {
  try {
    const nearby = await groupRideClient.findNearbyOpenMatchRequests(
      pickup.lat,
      pickup.lng,
      PICKUP_RADIUS_KM,
    );

    const heading = bearingDegrees(pickup, destination);
    const matches = nearby.filter((request) => {
      if (request.userId === riderId) return false;
      const destinationKm = haversineKm(
        destination.lat, destination.lng,
        request.destLat, request.destLng,
      );
      if (destinationKm > DESTINATION_RADIUS_KM) return false;
      const requestHeading = bearingDegrees(
        { lat: request.pickupLat, lng: request.pickupLng },
        { lat: request.destLat, lng: request.destLng },
      );
      return headingDeltaDegrees(heading, requestHeading) <= BEARING_THRESHOLD_DEG;
    });

    if (matches.length < SUGGEST_MIN_MATCHES) return null;

    return {
      count: matches.length,
      sampleDestination: matches[0]?.destAddress ?? '',
    };
  } catch (error) {
    console.warn('[group-ride-suggestion] check failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
