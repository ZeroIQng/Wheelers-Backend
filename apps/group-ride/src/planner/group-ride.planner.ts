import { randomUUID } from 'node:crypto';
import { groupRideClient } from '@wheleers/db';
import type { GoogleMapsRoutePlanner, GroupRideEnv } from '@wheleers/config';
import type {
  GroupRideCandidatesIdentifiedEvent,
  GroupRideEvent,
  GroupRideReadyForMatchEvent,
} from '@wheleers/kafka-schemas';

import { bearingDegrees } from '../algorithms/geo';
import { buildNearestRouteGroup, buildGroupFingerprint } from '../algorithms/grouping';
import { findNearestRouteCandidates } from '../algorithms/knn';
import { planGroupStops } from '../algorithms/stop-sequencer';
import { buildGroupRoute } from './route-builder';
import type { GroupRideEventsProducer } from '../producers/group-ride-events.producer';
import type { GroupRideState } from '../state';
import type { GroupRideRequest } from '../types';

export function createGroupRidePlanner(params: {
  env: GroupRideEnv;
  routePlanner: GoogleMapsRoutePlanner;
  groupRideEventsProducer: GroupRideEventsProducer;
  state: GroupRideState;
}): {
  handleRideReadyForMatch(event: GroupRideReadyForMatchEvent): Promise<void>;
  handleGroupRideEvent(event: GroupRideEvent): Promise<void>;
  seedRequest(request: GroupRideRequest): Promise<void>;
  releaseRide(rideId: string): void;
} {
  return {
    async handleRideReadyForMatch(event) {
      pruneExpiredRequests(params.state, params.env);

      if (params.state.assignedRideIds.has(event.rideId)) {
        return;
      }

      const request = mapReadyForMatchEvent(event);
      await enqueueReadyRequest(request);
    },

    async seedRequest(request) {
      pruneExpiredRequests(params.state, params.env);

      if (params.state.assignedRideIds.has(request.rideId)) {
        return;
      }

      await enqueueReadyRequest(request);
    },

    async handleGroupRideEvent(event) {
      if (event.eventType === 'GROUP_RIDE_READY_FOR_MATCH') {
        await this.handleRideReadyForMatch(event);
        return;
      }

      if (event.eventType === 'GROUP_RIDE_MATCH_CANCELLED') {
        this.releaseRide(event.rideId);
        return;
      }

      if (event.eventType === 'GROUP_RIDE_CANDIDATES_IDENTIFIED') {
        const members = event.members
          .map((member) => params.state.pendingRequestsByRideId.get(member.rideId))
          .filter((member): member is GroupRideRequest => member !== undefined)
          .filter((member) => !params.state.assignedRideIds.has(member.rideId));

        if (members.length < 2) {
          return;
        }

        const sequence = planGroupStops({
          anchorRideId: event.anchorRideId,
          members,
        });

        await params.groupRideEventsProducer.groupPlanned({
          eventType: 'GROUP_RIDE_PLANNED',
          groupId: event.groupId,
          anchorRideId: event.anchorRideId,
          rideIds: members.map((member) => member.rideId),
          riderIds: members.map((member) => member.riderId),
          stops: sequence.stops,
          heuristicDistanceKm: sequence.heuristicDistanceKm,
          sequenceAlgorithm: sequence.algorithm,
          timestamp: new Date().toISOString(),
        });

        await groupRideClient
          .assignRequestsToGroup({
            groupId: event.groupId,
            rideIds: members.map((member) => member.rideId),
            status: 'GROUPED',
          })
          .catch(() => null);

        for (const member of members) {
          params.state.assignedRideIds.add(member.rideId);
          params.state.pendingRequestsByRideId.delete(member.rideId);
        }
        return;
      }

      if (event.eventType === 'GROUP_RIDE_PLANNED') {
        const builtRoute = await buildGroupRoute({
          routePlanner: params.routePlanner,
          stops: event.stops,
        });

        await params.groupRideEventsProducer.routeBuilt({
          eventType: 'GROUP_RIDE_ROUTE_BUILT',
          groupId: event.groupId,
          anchorRideId: event.anchorRideId,
          rideIds: event.rideIds,
          riderIds: event.riderIds,
          stops: event.stops,
          legs: builtRoute.legs,
          totalDistanceKm: builtRoute.totalDistanceKm,
          totalDurationSeconds: builtRoute.totalDurationSeconds,
          route: builtRoute.route,
          routeAlgorithm: 'google_routes_segments',
          timestamp: new Date().toISOString(),
        });

        await groupRideClient
          .assignRequestsToGroup({
            groupId: event.groupId,
            rideIds: event.rideIds,
            status: 'BOOKED',
          })
          .catch(() => null);
        return;
      }

      if (event.eventType === 'GROUP_RIDE_ROUTE_BUILT') {
        console.log(
          `[group-ride] group=${event.groupId} riders=${event.riderIds.length} ` +
            `stops=${event.stops.length} distanceKm=${event.totalDistanceKm} ` +
            `durationS=${event.totalDurationSeconds}`,
        );

        // Trigger driver dispatch — first pickup stop becomes the driver's target
        const firstPickup = event.stops.find((s) => s.kind === 'pickup');
        if (firstPickup) {
          await params.groupRideEventsProducer.publish({
            eventType: 'GROUP_RIDE_DRIVER_DISPATCH_REQUESTED',
            groupId: event.groupId,
            anchorRideId: event.anchorRideId,
            rideIds: event.rideIds,
            riderIds: event.riderIds,
            firstPickup: { lat: firstPickup.lat, lng: firstPickup.lng, address: firstPickup.address },
            totalDistanceKm: event.totalDistanceKm,
            totalDurationSeconds: event.totalDurationSeconds,
            fareEstimateNgn: event.totalDistanceKm * 100, // rough per-km estimate
            route: event.route,
            timestamp: new Date().toISOString(),
          });
        }
      }
    },

    releaseRide(rideId) {
      params.state.pendingRequestsByRideId.delete(rideId);
      params.state.assignedRideIds.delete(rideId);
    },
  };

  async function enqueueReadyRequest(request: GroupRideRequest): Promise<void> {
    params.state.pendingRequestsByRideId.set(request.rideId, request);
    await groupRideClient.updateMatchRequestStatus(request.rideId, 'MATCHING').catch(() => null);

    const candidates = findNearestRouteCandidates(
      request,
      params.state.pendingRequestsByRideId.values(),
      params.env,
    );
    const group = buildNearestRouteGroup({
      anchor: request,
      candidates,
      env: params.env,
    });

    if (group.length < 2) {
      return;
    }

    const fingerprint = buildGroupFingerprint(group.map((member) => member.rideId));
    if (params.state.emittedCandidateFingerprints.has(fingerprint)) {
      return;
    }

    params.state.emittedCandidateFingerprints.add(fingerprint);

    const candidateEvent: GroupRideCandidatesIdentifiedEvent = {
      eventType: 'GROUP_RIDE_CANDIDATES_IDENTIFIED',
      groupId: randomUUID(),
      anchorRideId: request.rideId,
      rideIds: group.map((member) => member.rideId),
      members: group.map((member) => ({
        rideId: member.rideId,
        riderId: member.riderId,
        pickup: member.pickup,
        destination: member.destination,
        genderPreference: member.genderPreference,
        headingDeg: member.headingDeg,
        compatibilityScore:
          member.rideId === request.rideId
            ? 1
            : candidates.find((candidate) => candidate.request.rideId === member.rideId)
                ?.score ?? 0.5,
      })),
      searchRadiusKm: params.env.GROUP_RIDE_PICKUP_RADIUS_KM,
      maxBearingDeltaDeg: params.env.GROUP_RIDE_BEARING_THRESHOLD_DEG,
      timestamp: new Date().toISOString(),
    };

    try {
      await params.groupRideEventsProducer.candidatesIdentified(candidateEvent);
    } catch (error) {
      params.state.emittedCandidateFingerprints.delete(fingerprint);
      throw error;
    }
  }
}

function mapReadyForMatchEvent(event: GroupRideReadyForMatchEvent): GroupRideRequest {
  return {
    rideId: event.rideId,
    riderId: event.riderId,
    pickup: event.pickup,
    destination: event.destination,
    genderPreference: event.genderPreference,
    headingDeg: bearingDegrees(event.pickup, event.destination),
    fareEstimateNgn: event.fareEstimateNgn ?? 0,
    requestedAt: event.timestamp,
    sourceEvent: event,
  };
}

function pruneExpiredRequests(state: GroupRideState, env: GroupRideEnv): void {
  const expiresBefore = Date.now() - env.GROUP_RIDE_REQUEST_TTL_S * 1000;

  for (const [rideId, request] of state.pendingRequestsByRideId) {
    const requestedAt = new Date(request.requestedAt).getTime();
    if (!Number.isFinite(requestedAt) || requestedAt < expiresBefore) {
      state.pendingRequestsByRideId.delete(rideId);
      state.assignedRideIds.delete(rideId);
      void groupRideClient.updateMatchRequestStatus(rideId, 'EXPIRED').catch(() => null);
    }
  }
}
