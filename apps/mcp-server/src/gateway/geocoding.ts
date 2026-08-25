/**
 * Address → coordinates via Google Geocoding. Mirrors the gateway's WhatsApp
 * geocoder: bias to the home region first (keeps precise local landmarks and
 * international addresses), fall back to a hard country restriction only when
 * the biased query finds nothing, and reject results too coarse to route to.
 */

export interface GeocodeCandidate {
  lat: number;
  lng: number;
  formattedAddress: string;
}

interface GoogleGeocodingResponse {
  status: string;
  error_message?: string;
  results?: Array<{
    geometry?: { location?: { lat?: number; lng?: number } };
    formatted_address?: string;
    types?: string[];
    partial_match?: boolean;
  }>;
}

const TOO_COARSE_TYPES = new Set(['country', 'administrative_area_level_1', 'administrative_area_level_2']);

const GENERIC_QUERY_WORDS = new Set([
  'the', 'and', 'near', 'beside', 'opposite', 'behind',
  'street', 'road', 'avenue', 'close', 'crescent', 'way',
  'lagos', 'nigeria', 'state',
]);

function partialMatchLooksRelated(query: string, formattedAddress: string): boolean {
  const address = formattedAddress.toLowerCase();
  const meaningfulWords = query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 3 && !GENERIC_QUERY_WORDS.has(word));
  if (meaningfulWords.length === 0) return false;
  return meaningfulWords.some((word) => address.includes(word));
}

export interface GeocoderConfig {
  apiKey: string;
  region: string;
  fallbackCountry: string;
}

export class Geocoder {
  constructor(private readonly config: GeocoderConfig) {}

  async candidates(address: string, limit = 3): Promise<GeocodeCandidate[]> {
    const region = this.config.region.trim().toLowerCase();
    const biased = await this.query(address, region ? { region } : {}, limit);
    if (biased.length > 0) return biased;

    const country = this.config.fallbackCountry.trim().toUpperCase();
    if (!country) return [];
    return this.query(address, { components: `country:${country}` }, limit);
  }

  async reverse(lat: number, lng: number): Promise<string | null> {
    const params = new URLSearchParams({ latlng: `${lat},${lng}`, key: this.config.apiKey });
    const response = await fetch(`https://maps.googleapis.com/maps/api/geocode/json?${params}`);
    if (!response.ok) return null;
    const data = (await response.json()) as GoogleGeocodingResponse;
    if (data.status !== 'OK' || !data.results?.length) return null;
    return data.results[0].formatted_address ?? null;
  }

  private async query(
    address: string,
    extra: Record<string, string>,
    limit: number,
  ): Promise<GeocodeCandidate[]> {
    const params = new URLSearchParams({ address, key: this.config.apiKey, ...extra });
    const response = await fetch(`https://maps.googleapis.com/maps/api/geocode/json?${params}`);
    if (!response.ok) {
      throw new Error(`Geocoding request failed with HTTP ${response.status}`);
    }

    const data = (await response.json()) as GoogleGeocodingResponse;
    if (data.status === 'ZERO_RESULTS') return [];
    if (data.status !== 'OK') {
      throw new Error(`Geocoding failed: ${data.status}${data.error_message ? ` — ${data.error_message}` : ''}`);
    }

    const seen = new Set<string>();
    const candidates: GeocodeCandidate[] = [];
    for (const result of data.results ?? []) {
      const location = result.geometry?.location;
      if (typeof location?.lat !== 'number' || typeof location?.lng !== 'number') continue;
      if (result.types?.some((type) => TOO_COARSE_TYPES.has(type))) continue;
      if (result.partial_match && !partialMatchLooksRelated(address, result.formatted_address ?? '')) continue;
      const formattedAddress = result.formatted_address ?? address;
      if (seen.has(formattedAddress)) continue;
      seen.add(formattedAddress);
      candidates.push({ lat: location.lat, lng: location.lng, formattedAddress });
      if (candidates.length >= limit) break;
    }
    return candidates;
  }
}
