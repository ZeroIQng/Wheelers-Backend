import { GroupRideGenderPreference, groupRideClient } from '@wheleers/db';
import type { GroupRideReadyForMatchEvent } from '@wheleers/kafka-schemas';

type MatchRequestWithRelations = NonNullable<
  Awaited<ReturnType<typeof groupRideClient.findMatchRequestById>>
>;

/**
 * The one builder for GROUP_RIDE_READY_FOR_MATCH — used by both the HTTP
 * face-upload-complete route and the WhatsApp selfie flow, so the matcher
 * always receives the same shape regardless of the booking channel.
 */
export function buildReadyForMatchEvent(
  request: MatchRequestWithRelations,
): GroupRideReadyForMatchEvent {
  if (!request.faceVerification) {
    throw new Error('Face verification record is required before matching.');
  }

  return {
    eventType: 'GROUP_RIDE_READY_FOR_MATCH',
    rideId: request.id,
    riderId: request.userId,
    faceVerificationId: request.faceVerification.id,
    pickup: {
      lat: request.pickupLat,
      lng: request.pickupLng,
      address: request.pickupAddress,
    },
    destination: {
      lat: request.destLat,
      lng: request.destLng,
      address: request.destAddress,
    },
    stops: Array.isArray(request.stops) ? (request.stops as any) : [],
    plannedDistanceKm: request.plannedDistanceKm ?? undefined,
    plannedDurationSeconds: request.plannedDurationSeconds ?? undefined,
    fareEstimateNgn: groupRideDecimalToNumber(request.fareEstimateNgn) ?? undefined,
    genderPreference: serializeGroupRideGenderPreference(request.genderPreference),
    paymentMethod: 'wallet_balance',
    timestamp: new Date().toISOString(),
  };
}

export function serializeGroupRideGenderPreference(
  value: GroupRideGenderPreference,
): 'any' | 'women_only' | 'men_only' {
  if (value === GroupRideGenderPreference.WOMEN_ONLY) return 'women_only';
  if (value === GroupRideGenderPreference.MEN_ONLY) return 'men_only';
  return 'any';
}

export function groupRideDecimalToNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  if (
    value &&
    typeof value === 'object' &&
    'toString' in value &&
    typeof value.toString === 'function'
  ) {
    const parsed = Number(value.toString());
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}
