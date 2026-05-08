import type { LatLng } from '../types';

export function haversineKm(a: LatLng, b: LatLng): number {
  const toRad = (value: number) => (value * Math.PI) / 180;
  const r = 6371;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const p =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(a.lat)) *
      Math.cos(toRad(b.lat)) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);

  return r * (2 * Math.atan2(Math.sqrt(p), Math.sqrt(1 - p)));
}

export function bearingDegrees(a: LatLng, b: LatLng): number {
  const toRad = (value: number) => (value * Math.PI) / 180;
  const toDeg = (value: number) => (value * 180) / Math.PI;
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const dLng = toRad(b.lng - a.lng);

  const y = Math.sin(dLng) * Math.cos(lat2);
  const x =
    Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);

  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

export function headingDeltaDegrees(a: number, b: number): number {
  const delta = Math.abs(a - b) % 360;
  return delta > 180 ? 360 - delta : delta;
}

export function computeBounds(
  coordinates: Array<{ lat: number; lng: number }>,
): {
  northEast: { lat: number; lng: number };
  southWest: { lat: number; lng: number };
} {
  let minLat = coordinates[0]?.lat ?? 0;
  let maxLat = minLat;
  let minLng = coordinates[0]?.lng ?? 0;
  let maxLng = minLng;

  for (const coordinate of coordinates) {
    minLat = Math.min(minLat, coordinate.lat);
    maxLat = Math.max(maxLat, coordinate.lat);
    minLng = Math.min(minLng, coordinate.lng);
    maxLng = Math.max(maxLng, coordinate.lng);
  }

  return {
    northEast: { lat: maxLat, lng: maxLng },
    southWest: { lat: minLat, lng: minLng },
  };
}

export function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
