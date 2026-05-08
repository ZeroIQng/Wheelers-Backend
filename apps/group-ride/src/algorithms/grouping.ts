import type { GroupRideEnv } from '@wheleers/config';

import { scoreRideCompatibility } from './knn';
import type { CompatibleRideCandidate, GroupRideRequest } from '../types';

export function buildNearestRouteGroup(params: {
  anchor: GroupRideRequest;
  candidates: CompatibleRideCandidate[];
  env: GroupRideEnv;
}): GroupRideRequest[] {
  const group: GroupRideRequest[] = [params.anchor];

  for (const candidate of params.candidates) {
    if (group.length >= params.env.GROUP_RIDE_MAX_SIZE) {
      break;
    }

    const request = candidate.request;
    const compatibleWithGroup = group.every(
      (member) => scoreRideCompatibility(member, request, params.env) !== null,
    );
    if (compatibleWithGroup) {
      group.push(request);
    }
  }

  return group;
}

export function buildGroupFingerprint(rideIds: string[]): string {
  return rideIds.slice().sort().join(':');
}
