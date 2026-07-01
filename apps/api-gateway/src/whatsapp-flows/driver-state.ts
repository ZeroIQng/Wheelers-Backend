import type { RedisClient } from '../redis/client';

export interface WhatsappDriverProfile {
  userId: string;
  driverId: string;
  phone: string;
  name: string;
  rating: number;
  vehiclePlate: string;
  vehicleModel: string;
  lat: number;
  lng: number;
  onlineSince: string;
}

export interface WhatsappDriverOffer {
  rideId: string;
  riderId: string;
  pickupAddress: string;
  destinationAddress: string;
  riderOfferNgn: number;
  suggestedFareNgn: number;
  fareEstimateNgn: number;
  paymentMethod: 'CASH' | 'WALLET';
  plannedDistanceKm?: number;
  plannedDurationSeconds?: number;
  expiresAt: string;
  receivedAt: string;
}

const DRIVER_PROFILE_TTL = 86400;   // 24 hours
const DRIVER_OFFERS_TTL = 300;       // 5 minutes (ride offers expire quickly)
const DRIVER_PHONE_TTL = 86400;      // 24 hours
const DRIVER_ACTIVE_RIDE_TTL = 1800; // 30 minutes

function driverProfileKey(userId: string): string {
  return `whatsapp:driver:${userId}:profile`;
}

function driverOffersKey(userId: string): string {
  return `whatsapp:driver:${userId}:offers`;
}

function driverPhoneKey(userId: string): string {
  return `whatsapp:driver_phone:${userId}`;
}

function driverActiveRideKey(userId: string): string {
  return `whatsapp:driver:${userId}:active_ride`;
}

function driverByPhoneKey(phone: string): string {
  return `whatsapp:driver_by_phone:${phone}`;
}

export async function storeDriverProfile(
  redis: RedisClient,
  profile: WhatsappDriverProfile,
): Promise<void> {
  await redis.set(driverProfileKey(profile.userId), JSON.stringify(profile), DRIVER_PROFILE_TTL);
  await redis.set(driverByPhoneKey(profile.phone), profile.userId, DRIVER_PROFILE_TTL);
}

export async function getDriverProfile(
  redis: RedisClient,
  userId: string,
): Promise<WhatsappDriverProfile | null> {
  const raw = await redis.get(driverProfileKey(userId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as WhatsappDriverProfile;
  } catch {
    console.warn('[driver-state] Corrupted driver profile, clearing', { userId });
    await redis.del(driverProfileKey(userId)).catch(() => {});
    return null;
  }
}

export async function getDriverUserIdByPhone(
  redis: RedisClient,
  phone: string,
): Promise<string | null> {
  return redis.get(driverByPhoneKey(phone));
}

export async function clearDriverProfile(
  redis: RedisClient,
  userId: string,
): Promise<void> {
  const profile = await getDriverProfile(redis, userId);
  await redis.del(driverProfileKey(userId));
  if (profile) {
    await redis.del(driverByPhoneKey(profile.phone));
  }
}

export async function addDriverOffer(
  redis: RedisClient,
  userId: string,
  offer: WhatsappDriverOffer,
): Promise<void> {
  const offers = await getDriverOffers(redis, userId);
  // Replace if same ride, otherwise append
  const existing = offers.findIndex((o) => o.rideId === offer.rideId);
  if (existing >= 0) {
    offers[existing] = offer;
  } else {
    offers.push(offer);
  }
  await redis.set(driverOffersKey(userId), JSON.stringify(offers), DRIVER_OFFERS_TTL);
}

export async function getDriverOffers(
  redis: RedisClient,
  userId: string,
): Promise<WhatsappDriverOffer[]> {
  const raw = await redis.get(driverOffersKey(userId));
  if (!raw) return [];
  let offers: WhatsappDriverOffer[];
  try {
    offers = JSON.parse(raw) as WhatsappDriverOffer[];
  } catch {
    console.warn('[driver-state] Corrupted driver offers, clearing', { userId });
    await redis.del(driverOffersKey(userId)).catch(() => {});
    return [];
  }
  // Filter out expired offers
  const now = Date.now();
  return offers.filter((o) => new Date(o.expiresAt).getTime() > now);
}

export async function removeDriverOffer(
  redis: RedisClient,
  userId: string,
  rideId: string,
): Promise<void> {
  const offers = await getDriverOffers(redis, userId);
  const filtered = offers.filter((o) => o.rideId !== rideId);
  await redis.set(driverOffersKey(userId), JSON.stringify(filtered), DRIVER_OFFERS_TTL);
}

export async function setDriverActiveRide(
  redis: RedisClient,
  userId: string,
  rideId: string,
): Promise<void> {
  await redis.set(driverActiveRideKey(userId), rideId, DRIVER_ACTIVE_RIDE_TTL);
}

export async function getDriverActiveRide(
  redis: RedisClient,
  userId: string,
): Promise<string | null> {
  return redis.get(driverActiveRideKey(userId));
}

export async function clearDriverActiveRide(
  redis: RedisClient,
  userId: string,
): Promise<void> {
  await redis.del(driverActiveRideKey(userId));
}

export async function setDriverPhoneLookup(
  redis: RedisClient,
  userId: string,
  phone: string,
): Promise<void> {
  await redis.set(driverPhoneKey(userId), phone, DRIVER_PHONE_TTL);
}

export async function lookupDriverPhoneByUserId(
  redis: RedisClient,
  userId: string,
): Promise<string | null> {
  return redis.get(driverPhoneKey(userId));
}

export async function isWhatsappDriver(
  redis: RedisClient,
  driverUserId: string,
): Promise<boolean> {
  const profile = await redis.get(driverProfileKey(driverUserId)).catch(() => null);
  return profile !== null;
}
