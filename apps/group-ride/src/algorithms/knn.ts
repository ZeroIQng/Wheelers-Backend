import type { GroupRideEnv } from '@wheleers/config';

import { haversineKm, headingDeltaDegrees, round3 } from './geo';
import type { CompatibleRideCandidate, GroupRideRequest } from '../types';

export function findNearestRouteCandidates(
  anchor: GroupRideRequest,
  pool: Iterable<GroupRideRequest>,
  env: GroupRideEnv,
): CompatibleRideCandidate[] {
  const candidates: CompatibleRideCandidate[] = [];

  for (const request of pool) {
    if (request.rideId === anchor.rideId) {
      continue;
    }

    const candidate = scoreRideCompatibility(anchor, request, env);
    if (candidate) {
      candidates.push(candidate);
    }
  }

  return candidates
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }

      return left.pickupDistanceKm - right.pickupDistanceKm;
    })
    .slice(0, env.GROUP_RIDE_MAX_CANDIDATES);
}

export function scoreRideCompatibility(
  anchor: GroupRideRequest,
  request: GroupRideRequest,
  env: GroupRideEnv,
): CompatibleRideCandidate | null {
  const pickupDistanceKm = haversineKm(anchor.pickup, request.pickup);
  if (pickupDistanceKm > env.GROUP_RIDE_PICKUP_RADIUS_KM) {
    return null;
  }

  const destinationDistanceKm = haversineKm(
    anchor.destination,
    request.destination,
  );
  if (destinationDistanceKm > env.GROUP_RIDE_DESTINATION_RADIUS_KM) {
    return null;
  }

  const headingDeltaDeg = headingDeltaDegrees(
    anchor.headingDeg,
    request.headingDeg,
  );
  if (headingDeltaDeg > env.GROUP_RIDE_BEARING_THRESHOLD_DEG) {
    return null;
  }

  const pickupComponent =
    1 - pickupDistanceKm / env.GROUP_RIDE_PICKUP_RADIUS_KM;
  const destinationComponent =
    1 - destinationDistanceKm / env.GROUP_RIDE_DESTINATION_RADIUS_KM;
  const headingComponent =
    1 - headingDeltaDeg / env.GROUP_RIDE_BEARING_THRESHOLD_DEG;

  const score = round3(
    Math.max(
      0,
      0.45 * pickupComponent +
        0.35 * destinationComponent +
        0.2 * headingComponent,
    ),
  );

  return {
    request,
    pickupDistanceKm: round3(pickupDistanceKm),
    destinationDistanceKm: round3(destinationDistanceKm),
    headingDeltaDeg: round3(headingDeltaDeg),
    score,
  };
}
