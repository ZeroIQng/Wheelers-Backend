import type { GroupRideRequest } from './types';

export type GroupRideState = {
  pendingRequestsByRideId: Map<string, GroupRideRequest>;
  assignedRideIds: Set<string>;
  emittedCandidateFingerprints: Set<string>;
};

export function createGroupRideState(): GroupRideState {
  return {
    pendingRequestsByRideId: new Map(),
    assignedRideIds: new Set(),
    emittedCandidateFingerprints: new Set(),
  };
}
