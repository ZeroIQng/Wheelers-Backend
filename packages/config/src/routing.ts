import { FEES } from './constants/fees';
import { RIDE } from './constants/ride';

export type RouteWaypoint = {
  lat: number;
  lng: number;
};

export type PlannedRouteMetrics = {
  distanceKm: number;
  durationSeconds: number;
  fareEstimateUsdt: number;
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
        `v2/directions/${encodeURIComponent(this.profile)}/json`,
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

    return {
      distanceKm,
      durationSeconds,
      fareEstimateUsdt,
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

function extractPrimaryRoute(payload: unknown): { distance: number; duration: number } {
  if (!payload || typeof payload !== 'object') {
    throw new RoutePlanningError('OpenRouteService returned an invalid response body');
  }

  const routes = (payload as { routes?: unknown }).routes;
  if (!Array.isArray(routes) || routes.length === 0) {
    throw new RoutePlanningError('OpenRouteService returned no routes');
  }

  const summary = (routes[0] as { summary?: unknown }).summary;
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

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
