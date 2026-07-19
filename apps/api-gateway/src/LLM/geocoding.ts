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
  }>;
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

export async function geocodeAddress(
  apiKey: string,
  address: string,
): Promise<GeocodeResult | null> {
  const params = new URLSearchParams({
    address,
    key: apiKey,
    // Bias results towards Lagos, Nigeria
    components: 'country:NG',
    region: 'ng',
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
      console.warn('[geocoding] No results for address', { address, status: data.status });
      return null;
    }

    const result = data.results[0];
    const location = result.geometry?.location;
    if (!location?.lat || !location?.lng) {
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
