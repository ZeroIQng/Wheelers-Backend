import type { GoogleMapsRoutePlanner } from '@wheleers/config';

import { computeBounds, round3 } from '../algorithms/geo';
import type { BuiltGroupRouteLeg, PlannedGroupStop } from '../types';

export async function buildGroupRoute(params: {
  routePlanner: GoogleMapsRoutePlanner;
  stops: PlannedGroupStop[];
}): Promise<{
  legs: BuiltGroupRouteLeg[];
  totalDistanceKm: number;
  totalDurationSeconds: number;
  route: {
    coordinates: Array<{ lat: number; lng: number }>;
    bounds: {
      northEast: { lat: number; lng: number };
      southWest: { lat: number; lng: number };
    };
  };
}> {
  const legs: BuiltGroupRouteLeg[] = [];
  const mergedCoordinates: Array<{ lat: number; lng: number }> = [];
  let totalDistanceKm = 0;
  let totalDurationSeconds = 0;

  for (let index = 1; index < params.stops.length; index += 1) {
    const from = params.stops[index - 1];
    const to = params.stops[index];

    const plannedLeg = await params.routePlanner.planRoute({
      origin: from,
      destination: to,
    });

    legs.push({
      fromSequence: from.sequence,
      toSequence: to.sequence,
      distanceKm: plannedLeg.distanceKm,
      durationSeconds: plannedLeg.durationSeconds,
      route: plannedLeg.geometry,
    });

    totalDistanceKm += plannedLeg.distanceKm;
    totalDurationSeconds += plannedLeg.durationSeconds;

    if (mergedCoordinates.length === 0) {
      mergedCoordinates.push(...plannedLeg.geometry.coordinates);
    } else {
      mergedCoordinates.push(...plannedLeg.geometry.coordinates.slice(1));
    }
  }

  const coordinates =
    mergedCoordinates.length >= 2
      ? mergedCoordinates
      : params.stops.map((stop) => ({ lat: stop.lat, lng: stop.lng }));

  return {
    legs,
    totalDistanceKm: round3(totalDistanceKm),
    totalDurationSeconds: Math.round(totalDurationSeconds),
    route: {
      coordinates,
      bounds: computeBounds(coordinates),
    },
  };
}
