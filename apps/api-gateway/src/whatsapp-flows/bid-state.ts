import type { RedisClient } from '../redis/client';

export type RideState = 'setup' | 'searching' | 'bidding' | 'confirmed' | 'in_progress' | 'completed';

export interface PendingLocation {
  lat: number;
  lng: number;
  address: string;
  savedAt: string;
}

export interface WhatsappRideMeta {
  riderId: string;
  phone: string;
  pickupAddress: string;
  pickupLat?: number;
  pickupLng?: number;
  destinationAddress: string;
  destinationLat?: number;
  destinationLng?: number;
  distanceKm?: number;
  durationSeconds?: number;
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

const RIDE_META_TTL = 900;           // 15 minutes
const BIDS_TTL = 900;                // 15 minutes
const RIDE_STATE_TTL = 1800;         // 30 minutes
const ACTIVE_RIDE_TTL = 1800;        // 30 minutes
const PENDING_LOCATION_TTL = 600;    // 10 minutes
const PHONE_LOOKUP_TTL = 86400;      // 24 hours
const DEBOUNCE_TTL = 30;             // 30 seconds

function rideMetaKey(rideId: string): string {
  return `whatsapp:ride:${rideId}:meta`;
}

function rideBidsKey(rideId: string): string {
  return `whatsapp:ride:${rideId}:bids`;
}

function rideStateKey(rideId: string): string {
  return `whatsapp:ride:${rideId}:state`;
}

function activeRideKey(userId: string): string {
  return `whatsapp:user:${userId}:active_ride`;
}

function pendingLocationKey(userId: string): string {
  return `whatsapp:user:${userId}:pending_location`;
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
  await Promise.all([
    redis.set(rideMetaKey(rideId), JSON.stringify(meta), RIDE_META_TTL),
    redis.set(rideBidsKey(rideId), JSON.stringify([]), BIDS_TTL),
    redis.set(rideStateKey(rideId), 'searching' as RideState, RIDE_STATE_TTL),
  ]);
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

export async function clearBids(
  redis: RedisClient,
  rideId: string,
): Promise<void> {
  await redis.set(rideBidsKey(rideId), JSON.stringify([]), BIDS_TTL);
}

export async function removeBid(
  redis: RedisClient,
  rideId: string,
  driverId: string,
): Promise<WhatsappBid[]> {
  const bids = await getBids(redis, rideId);
  const filtered = bids.filter((b) => b.driverId !== driverId);
  await redis.set(rideBidsKey(rideId), JSON.stringify(filtered), BIDS_TTL);
  return filtered;
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
    redis.del(rideStateKey(rideId)),
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

// ── Accepted bid (stored so driver profile flow can read it) ──────────────

export interface AcceptedBidInfo {
  driverName: string;
  driverPhone: string;
  driverUserId: string;
  vehicleModel: string;
  vehiclePlate: string;
  vehicleColor: string;
  driverRating: number;
  totalRides: number;
  etaSeconds: number;
  fareNgn: number;
}

function acceptedBidKey(rideId: string): string {
  return `whatsapp:ride:${rideId}:accepted_bid`;
}

export async function storeAcceptedBid(
  redis: RedisClient,
  rideId: string,
  info: AcceptedBidInfo,
): Promise<void> {
  await redis.set(acceptedBidKey(rideId), JSON.stringify(info), RIDE_STATE_TTL);
}

export async function getAcceptedBid(
  redis: RedisClient,
  rideId: string,
): Promise<AcceptedBidInfo | null> {
  const raw = await redis.get(acceptedBidKey(rideId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as AcceptedBidInfo;
  } catch {
    return null;
  }
}

// ── Ride state machine ─────────────────────────────────────────────────────

export async function setRideState(
  redis: RedisClient,
  rideId: string,
  state: RideState,
): Promise<void> {
  await redis.set(rideStateKey(rideId), state, RIDE_STATE_TTL);
}

export async function getRideState(
  redis: RedisClient,
  rideId: string,
): Promise<RideState | null> {
  const raw = await redis.get(rideStateKey(rideId));
  return (raw as RideState) ?? null;
}

// ── Pending location (saved when rider shares WhatsApp location pin) ────

export async function setPendingLocation(
  redis: RedisClient,
  userId: string,
  location: PendingLocation,
): Promise<void> {
  await redis.set(pendingLocationKey(userId), JSON.stringify(location), PENDING_LOCATION_TTL);
}

export async function getPendingLocation(
  redis: RedisClient,
  userId: string,
): Promise<PendingLocation | null> {
  const raw = await redis.get(pendingLocationKey(userId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PendingLocation;
  } catch {
    return null;
  }
}

export async function clearPendingLocation(
  redis: RedisClient,
  userId: string,
): Promise<void> {
  await redis.del(pendingLocationKey(userId));
}
