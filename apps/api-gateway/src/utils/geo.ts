export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = (n: number) => (n * Math.PI) / 180;
  const r = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return r * c;
}

/**
 * ~24 km/h average city driving — matches the driver app and ride-service so
 * every surface quotes the same ETA for the same distance. Never below 1 min.
 */
const SECONDS_PER_KM = 150;

export function estimateEtaSeconds(distanceKm: number): number {
  return Math.max(60, Math.round(distanceKm * SECONDS_PER_KM));
}
