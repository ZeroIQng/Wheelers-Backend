interface GeocodeResult {
  lat: number;
  lng: number;
  formattedAddress: string;
}

interface GoogleGeocodingResponse {
  status: string;
  results?: Array<{
    geometry?: {
      location?: {
        lat?: number;
        lng?: number;
      };
    };
    formatted_address?: string;
    types?: string[];
    partial_match?: boolean;
  }>;
}

/**
 * Result types too coarse to be a pickup or drop-off. Under a country
 * restriction Google will happily answer unrecognised text with the country
 * itself — "asdkjhasd nonsense" resolves to "Nigeria" — which would otherwise
 * be accepted as a real address and send a driver to the country centroid.
 */
const TOO_COARSE_TYPES = new Set([
  'country',
  'administrative_area_level_1',
  'administrative_area_level_2',
]);

/**
 * Google marks a result `partial_match` when it could not match the whole
 * query and guessed. Some guesses are fine ("Shoprite Ikeja" → "Shoprite,
 * Ikeja Roundabout") but some are garbage — "University gate" resolved to
 * "Street U, Eti-Osa, Lekki", 50 km from anywhere the rider meant, purely
 * because the street is named "U". The garbage guesses share no words with
 * the query, so a partial match is accepted only when at least one meaningful
 * query word appears in the returned address.
 */
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

export async function reverseGeocode(
  apiKey: string,
  lat: number,
  lng: number,
): Promise<GeocodeResult | null> {
  const params = new URLSearchParams({
    latlng: `${lat},${lng}`,
    key: apiKey,
  });

  const url = `https://maps.googleapis.com/maps/api/geocode/json?${params.toString()}`;

  try {
    const response = await fetch(url);
    if (!response.ok) return null;

    const data = (await response.json()) as GoogleGeocodingResponse;
    if (data.status !== 'OK' || !data.results?.length) return null;

    const result = data.results[0];
    return {
      lat,
      lng,
      formattedAddress: result.formatted_address ?? `${lat.toFixed(4)}, ${lng.toFixed(4)}`,
    };
  } catch {
    return null;
  }
}

/**
 * Home region, as a Google `region` bias. Set GEOCODE_REGION='' to disable when
 * testing abroad — the reason the bias was removed in the first place.
 */
const GEOCODE_REGION = (process.env['GEOCODE_REGION'] ?? 'ng').trim().toLowerCase();

/**
 * Hard country restriction, used ONLY as a second attempt.
 */
const GEOCODE_FALLBACK_COUNTRY = (process.env['GEOCODE_FALLBACK_COUNTRY'] ?? 'NG')
  .trim()
  .toUpperCase();

/**
 * Two attempts, because neither bias is right on its own. Measured against the
 * live API:
 *
 *   query              no bias        components=country:NG     region=ng
 *   "Allen"            ZERO_RESULTS   Allen area                ZERO_RESULTS
 *   "Allen roundabout" Allen Rndbt    Allen area (worse)        Allen Rndbt
 *   "Pier 39"          SF             — (NG only)               SF
 *
 * `region` biases ranking without excluding anything, so precise local
 * landmarks and international addresses both survive. `components=country`
 * filters, which rescues a bare neighbourhood name like "Allen" but flattens a
 * precise match to the broad area and blocks anywhere outside the country.
 * So: bias first, and only fall back to the restriction when that finds
 * nothing at all.
 */
export async function geocodeAddress(
  apiKey: string,
  address: string,
): Promise<GeocodeResult | null> {
  const biased = await geocodeOnce(apiKey, address, {
    ...(GEOCODE_REGION ? { region: GEOCODE_REGION } : {}),
  });
  if (biased) return biased;

  if (!GEOCODE_FALLBACK_COUNTRY) return null;

  const restricted = await geocodeOnce(apiKey, address, {
    components: `country:${GEOCODE_FALLBACK_COUNTRY}`,
  });
  if (restricted) {
    console.info('[geocoding] resolved only under country restriction', {
      address,
      country: GEOCODE_FALLBACK_COUNTRY,
      resolvedTo: restricted.formattedAddress,
    });
  }
  return restricted;
}

async function geocodeOnce(
  apiKey: string,
  address: string,
  extra: Record<string, string>,
): Promise<GeocodeResult | null> {
  const params = new URLSearchParams({
    address,
    key: apiKey,
    ...extra,
  });

  const url = `https://maps.googleapis.com/maps/api/geocode/json?${params.toString()}`;

  try {
    const response = await fetch(url);
    if (!response.ok) {
      console.warn('[geocoding] Google API error', { status: response.status });
      return null;
    }

    const data = (await response.json()) as GoogleGeocodingResponse;
    if (data.status !== 'OK' || !data.results?.length) {
      return null;
    }

    const result = data.results[0];
    const location = result.geometry?.location;
    if (!location?.lat || !location?.lng) {
      return null;
    }

    if (result.types?.some((type) => TOO_COARSE_TYPES.has(type))) {
      console.warn('[geocoding] ignoring result — too coarse to route to', {
        address,
        resolvedTo: result.formatted_address,
        types: result.types,
      });
      return null;
    }

    if (
      result.partial_match &&
      !partialMatchLooksRelated(address, result.formatted_address ?? '')
    ) {
      console.warn('[geocoding] ignoring partial match — unrelated to query', {
        address,
        resolvedTo: result.formatted_address,
      });
      return null;
    }

    return {
      lat: location.lat,
      lng: location.lng,
      formattedAddress: result.formatted_address ?? address,
    };
  } catch (error) {
    console.warn('[geocoding] Failed', {
      address,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
