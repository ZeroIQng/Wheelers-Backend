import type {
  GroupRideCandidatesIdentifiedEvent,
  GroupRideReadyForMatchEvent,
  GroupRidePlannedEvent,
} from '@wheleers/kafka-schemas';

export type LatLng = {
  lat: number;
  lng: number;
};

export type AddressPoint = LatLng & {
  address: string;
};

export type GroupRideRequest = {
  rideId: string;
  riderId: string;
  pickup: AddressPoint;
  destination: AddressPoint;
  headingDeg: number;
  fareEstimateUsdt: number;
  requestedAt: string;
  sourceEvent: GroupRideReadyForMatchEvent;
};

export type CompatibleRideCandidate = {
  request: GroupRideRequest;
  pickupDistanceKm: number;
  destinationDistanceKm: number;
  headingDeltaDeg: number;
  score: number;
};

export type PlannedGroupStop = GroupRidePlannedEvent['stops'][number];

export type CandidateGroupMember =
  GroupRideCandidatesIdentifiedEvent['members'][number];

export type BuiltGroupRouteLeg = {
  fromSequence: number;
  toSequence: number;
  distanceKm: number;
  durationSeconds: number;
  route: {
    coordinates: Array<{ lat: number; lng: number }>;
    bounds: {
      northEast: { lat: number; lng: number };
      southWest: { lat: number; lng: number };
    };
  };
};
