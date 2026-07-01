import type { RedisClient } from '../redis/client';

export interface WhatsappRideMeta {
  riderId: string;
  phone: string;
  pickupAddress: string;
  destinationAddress: string;
  offerNgn: number;
  suggestedFareNgn: number;
  paymentMethod: 'CASH' | 'WALLET';
  createdAt: string;
}

export interface WhatsappBid {
  driverId: string;
  driverUserId: string;
  counterOfferNgn: number;
  driverName: string;
  driverRating: number;
  vehiclePlate: string;
  vehicleModel: string;
  etaSeconds: number;
  receivedAt: string;
}

const RIDE_META_TTL = 900;       // 15 minutes
const BIDS_TTL = 900;            // 15 minutes
const ACTIVE_RIDE_TTL = 1800;    // 30 minutes
const PHONE_LOOKUP_TTL = 86400;  // 24 hours
const DEBOUNCE_TTL = 30;         // 30 seconds

function rideMetaKey(rideId: string): string {
  return `whatsapp:ride:${rideId}:meta`;
}

function rideBidsKey(rideId: string): string {
  return `whatsapp:ride:${rideId}:bids`;
}

function activeRideKey(userId: string): string {
  return `whatsapp:user:${userId}:active_ride`;
}

function phoneLookupKey(userId: string): string {
  return `whatsapp:phone_by_user:${userId}`;
}

function debounceKey(rideId: string): string {
  return `whatsapp:ride:${rideId}:last_notified`;
}

export async function storeWhatsappRide(
  redis: RedisClient,
  rideId: string,
  meta: WhatsappRideMeta,
): Promise<void> {
  await redis.set(rideMetaKey(rideId), JSON.stringify(meta), RIDE_META_TTL);
  await redis.set(rideBidsKey(rideId), JSON.stringify([]), BIDS_TTL);
}

export async function getRideMeta(
  redis: RedisClient,
  rideId: string,
): Promise<WhatsappRideMeta | null> {
  const raw = await redis.get(rideMetaKey(rideId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as WhatsappRideMeta;
  } catch {
    console.warn('[bid-state] Corrupted ride meta, clearing', { rideId });
    await redis.del(rideMetaKey(rideId)).catch(() => {});
    return null;
  }
}

export async function addBid(
  redis: RedisClient,
  rideId: string,
  bid: WhatsappBid,
): Promise<number> {
  const bids = await getBids(redis, rideId);
  // Replace if same driver already bid, otherwise append
  const existing = bids.findIndex((b) => b.driverId === bid.driverId);
  if (existing >= 0) {
    bids[existing] = bid;
  } else {
    bids.push(bid);
  }
  await redis.set(rideBidsKey(rideId), JSON.stringify(bids), BIDS_TTL);
  return bids.length;
}

export async function getBids(
  redis: RedisClient,
  rideId: string,
): Promise<WhatsappBid[]> {
  const raw = await redis.get(rideBidsKey(rideId));
  if (!raw) return [];
  try {
    return JSON.parse(raw) as WhatsappBid[];
  } catch {
    console.warn('[bid-state] Corrupted bids data, clearing', { rideId });
    await redis.del(rideBidsKey(rideId)).catch(() => {});
    return [];
  }
}

export async function setActiveRide(
  redis: RedisClient,
  userId: string,
  rideId: string,
): Promise<void> {
  await redis.set(activeRideKey(userId), rideId, ACTIVE_RIDE_TTL);
}

export async function getActiveRide(
  redis: RedisClient,
  userId: string,
): Promise<string | null> {
  return redis.get(activeRideKey(userId));
}

export async function clearActiveRide(
  redis: RedisClient,
  userId: string,
): Promise<void> {
  await redis.del(activeRideKey(userId));
}

export async function isWhatsappRider(
  redis: RedisClient,
  riderId: string,
): Promise<boolean> {
  const activeRide = await redis.get(activeRideKey(riderId)).catch(() => null);
  return activeRide !== null;
}

export async function setPhoneLookup(
  redis: RedisClient,
  userId: string,
  phone: string,
): Promise<void> {
  await redis.set(phoneLookupKey(userId), phone, PHONE_LOOKUP_TTL);
}

export async function lookupPhoneByUserId(
  redis: RedisClient,
  userId: string,
): Promise<string | null> {
  return redis.get(phoneLookupKey(userId));
}

export async function cleanupRideKeys(
  redis: RedisClient,
  rideId: string,
): Promise<void> {
  await Promise.all([
    redis.del(rideMetaKey(rideId)),
    redis.del(rideBidsKey(rideId)),
    redis.del(debounceKey(rideId)),
  ]).catch(() => {});
}

export async function shouldNotify(
  redis: RedisClient,
  rideId: string,
): Promise<boolean> {
  const existing = await redis.get(debounceKey(rideId)).catch(() => null);
  if (existing) return false;
  await redis.set(debounceKey(rideId), Date.now().toString(), DEBOUNCE_TTL);
  return true;
}
