import { FEES } from './constants/fees';
import { RIDE } from './constants/ride';
import { calculateRidePrice, type RidePriceBreakdown } from './pricing';

export type RouteWaypoint = {
  lat: number;
  lng: number;
};

export type RouteBounds = {
  northEast: RouteWaypoint;
  southWest: RouteWaypoint;
};

export type PlannedRouteGeometry = {
  coordinates: RouteWaypoint[];
  bounds: RouteBounds;
};

export type PlannedRouteMetrics = {
  distanceKm: number;
  durationSeconds: number;
  fareEstimateUsdt: number;
  ridePrice: RidePriceBreakdown;
  geometry: PlannedRouteGeometry;
};

export class RoutePlanningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RoutePlanningError';
  }
}

export class OpenRouteServiceClient {
  private readonly normalizedBaseUrl: URL;

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly profile = 'driving-car',
  ) {
    this.normalizedBaseUrl = normalizeOpenRouteServiceBaseUrl(baseUrl);
  }

  async planRoute(params: {
    origin: RouteWaypoint;
    stops?: RouteWaypoint[];
    destination: RouteWaypoint;
  }): Promise<PlannedRouteMetrics> {
    const coordinates = [
      [params.origin.lng, params.origin.lat],
      ...(params.stops ?? []).map((stop) => [stop.lng, stop.lat]),
      [params.destination.lng, params.destination.lat],
    ];

    if (coordinates.length < 2) {
      throw new RoutePlanningError('At least origin and destination are required');
    }

    const response = await fetch(
      new URL(
        `v2/directions/${encodeURIComponent(this.profile)}/geojson`,
        this.normalizedBaseUrl,
      ),
      {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          Authorization: this.apiKey,
          'x-api-key': this.apiKey,
        },
        body: JSON.stringify({
          coordinates,
          instructions: false,
          maneuvers: false,
        }),
      },
    );

    const contentType = response.headers.get('content-type') ?? '';
    const payload = contentType.includes('application/json')
      ? await response.json()
      : await response.text();

    if (!response.ok) {
      throw new RoutePlanningError(
        `OpenRouteService request failed with status ${response.status}`,
      );
    }

    const route = extractPrimaryRoute(payload);
    const distanceKm = round3(route.distance / 1000);
    const durationSeconds = Math.max(0, Math.round(route.duration));
    const fareEstimateUsdt = estimateRideFareUsdt({
      distanceKm,
      durationSeconds,
      stopCount: params.stops?.length ?? 0,
    });
    const ridePrice = calculateRidePrice(distanceKm);

    return {
      distanceKm,
      durationSeconds,
      fareEstimateUsdt,
      ridePrice,
      geometry: {
        coordinates: route.coordinates,
        bounds: route.bounds,
      },
    };
  }
}

function normalizeOpenRouteServiceBaseUrl(baseUrl: string): URL {
  const url = new URL(baseUrl);

  // HeiGIT's new API host requires the service prefix in the path.
  // Example: https://api.heigit.org/openrouteservice/v2/directions
  if (
    url.hostname === 'api.heigit.org' &&
    (url.pathname === '/' || url.pathname.trim() === '')
  ) {
    url.pathname = '/openrouteservice/';
  }

  if (!url.pathname.endsWith('/')) {
    url.pathname = `${url.pathname}/`;
  }

  return url;
}

export function estimateRideFareUsdt(params: {
  distanceKm: number;
  durationSeconds: number;
  stopCount: number;
}): number {
  const durationMinutes = params.durationSeconds / 60;
  const estimate =
    RIDE.BASE_FARE_USDT +
    params.distanceKm * RIDE.PER_KM_USDT +
    durationMinutes * RIDE.PER_MINUTE_USDT +
    params.stopCount * RIDE.PER_STOP_USDT;

  return round2(Math.max(estimate, FEES.MIN_RIDE_FARE_USDT));
}

function extractPrimaryRoute(payload: unknown): {
  distance: number;
  duration: number;
  coordinates: RouteWaypoint[];
  bounds: RouteBounds;
} {
  if (!payload || typeof payload !== 'object') {
    throw new RoutePlanningError('OpenRouteService returned an invalid response body');
  }

  const featureCollection = payload as {
    features?: unknown;
    bbox?: unknown;
  };
  if (Array.isArray(featureCollection.features) && featureCollection.features.length > 0) {
    const feature = featureCollection.features[0] as {
      geometry?: unknown;
      properties?: unknown;
    };
    const summary = getRouteSummary(feature.properties);
    const coordinates = parseLineCoordinates(feature.geometry);
    const bounds = parseBounds(featureCollection.bbox) ?? computeBounds(coordinates);

    return {
      distance: summary.distance,
      duration: summary.duration,
      coordinates,
      bounds,
    };
  }

  const routeCollection = payload as { bbox?: unknown; routes?: unknown };
  const routes = routeCollection.routes;
  if (!Array.isArray(routes) || routes.length === 0) {
    throw new RoutePlanningError('OpenRouteService returned no routes');
  }

  const primaryRoute = routes[0] as { bbox?: unknown; geometry?: unknown; summary?: unknown };
  const summary = getRouteSummary(primaryRoute.summary);
  const coordinates = parseJsonRouteCoordinates(primaryRoute.geometry);
  const bounds =
    parseBounds(primaryRoute.bbox) ??
    parseBounds(routeCollection.bbox) ??
    computeBounds(coordinates);

  return {
    distance: summary.distance,
    duration: summary.duration,
    coordinates,
    bounds,
  };
}

function getRouteSummary(summary: unknown): { distance: number; duration: number } {
  if (!summary || typeof summary !== 'object') {
    throw new RoutePlanningError('OpenRouteService response is missing route summary');
  }

  const distance = (summary as { distance?: unknown }).distance;
  const duration = (summary as { duration?: unknown }).duration;
  if (
    typeof distance !== 'number' ||
    !Number.isFinite(distance) ||
    typeof duration !== 'number' ||
    !Number.isFinite(duration)
  ) {
    throw new RoutePlanningError('OpenRouteService returned invalid distance or duration');
  }

  return { distance, duration };
}

function parseLineCoordinates(geometry: unknown): RouteWaypoint[] {
  if (!geometry || typeof geometry !== 'object') {
    throw new RoutePlanningError('OpenRouteService response is missing route geometry');
  }

  const coordinates = (geometry as { coordinates?: unknown }).coordinates;
  return parseCoordinatePairs(coordinates);
}

function parseJsonRouteCoordinates(geometry: unknown): RouteWaypoint[] {
  if (typeof geometry === 'string') {
    return decodePolyline(geometry);
  }

  if (Array.isArray(geometry)) {
    return parseCoordinatePairs(geometry);
  }

  if (geometry && typeof geometry === 'object') {
    return parseCoordinatePairs((geometry as { coordinates?: unknown }).coordinates);
  }

  throw new RoutePlanningError('OpenRouteService response is missing route geometry');
}

function parseCoordinatePairs(value: unknown): RouteWaypoint[] {
  if (!Array.isArray(value) || value.length < 2) {
    throw new RoutePlanningError('OpenRouteService returned invalid route coordinates');
  }

  const coordinates = value.map((pair) => {
    if (
      !Array.isArray(pair) ||
      pair.length < 2 ||
      typeof pair[0] !== 'number' ||
      !Number.isFinite(pair[0]) ||
      typeof pair[1] !== 'number' ||
      !Number.isFinite(pair[1])
    ) {
      throw new RoutePlanningError('OpenRouteService returned invalid coordinate pairs');
    }

    return {
      lng: pair[0],
      lat: pair[1],
    };
  });

  if (coordinates.length < 2) {
    throw new RoutePlanningError('OpenRouteService returned too few route coordinates');
  }

  return coordinates;
}

function parseBounds(value: unknown): RouteBounds | null {
  if (
    !Array.isArray(value) ||
    value.length < 4 ||
    typeof value[0] !== 'number' ||
    typeof value[1] !== 'number' ||
    typeof value[2] !== 'number' ||
    typeof value[3] !== 'number'
  ) {
    return null;
  }

  return {
    southWest: {
      lng: value[0],
      lat: value[1],
    },
    northEast: {
      lng: value[2],
      lat: value[3],
    },
  };
}

function computeBounds(coordinates: RouteWaypoint[]): RouteBounds {
  let minLat = coordinates[0]?.lat ?? 0;
  let maxLat = minLat;
  let minLng = coordinates[0]?.lng ?? 0;
  let maxLng = minLng;

  coordinates.forEach((coordinate) => {
    minLat = Math.min(minLat, coordinate.lat);
    maxLat = Math.max(maxLat, coordinate.lat);
    minLng = Math.min(minLng, coordinate.lng);
    maxLng = Math.max(maxLng, coordinate.lng);
  });

  return {
    southWest: {
      lat: minLat,
      lng: minLng,
    },
    northEast: {
      lat: maxLat,
      lng: maxLng,
    },
  };
}

function decodePolyline(encoded: string): RouteWaypoint[] {
  const coordinates: RouteWaypoint[] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;

  while (index < encoded.length) {
    const latitudeDelta = decodePolylineValue(encoded, index);
    lat += latitudeDelta.value;
    index = latitudeDelta.nextIndex;

    const longitudeDelta = decodePolylineValue(encoded, index);
    lng += longitudeDelta.value;
    index = longitudeDelta.nextIndex;

    coordinates.push({
      lat: lat / 1e5,
      lng: lng / 1e5,
    });
  }

  if (coordinates.length < 2) {
    throw new RoutePlanningError('OpenRouteService returned too few polyline coordinates');
  }

  return coordinates;
}

function decodePolylineValue(
  encoded: string,
  startIndex: number,
): { value: number; nextIndex: number } {
  let result = 0;
  let shift = 0;
  let index = startIndex;

  while (index < encoded.length) {
    const byte = encoded.charCodeAt(index) - 63;
    index += 1;
    result |= (byte & 0x1f) << shift;
    shift += 5;

    if (byte < 0x20) {
      const value = result & 1 ? ~(result >> 1) : result >> 1;
      return { value, nextIndex: index };
    }
  }

  throw new RoutePlanningError('OpenRouteService returned an invalid encoded polyline');
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
