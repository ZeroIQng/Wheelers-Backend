import { createHmac, randomUUID, timingSafeEqual } from 'crypto';
import type { IncomingMessage, ServerResponse } from 'http';
import { userClient, walletClient, driverClient } from '@wheleers/db';
import { GoogleMapsRoutePlanner, validateRiderOffer } from '@wheleers/config';
import { RideRequestedEvent, RideCancelledEvent, RideOfferAcceptedEvent } from '@wheleers/kafka-schemas';
import type { PouchLiquifiaClient } from '@wheleers/pouch-client';
import type { GatewayPublisher } from '../websocket/publisher';
import { onboardWhatsappUser } from '../onboarding/user-onboarding';
import {
  appendWhatsappConversation,
  getWhatsappConversation,
} from '../LLM/conversation-store';
import { WhatsappBotService } from '../LLM/whatsapp-bot.service';
import { GroqClient } from '../LLM/groq.client';
import { parseRideIntent } from '../LLM/ride-intent-parser';
import { geocodeAddress, reverseGeocode } from '../LLM/geocoding';
import {
  storeWhatsappRide,
  setActiveRide,
  getActiveRide,
  clearActiveRide,
  setPhoneLookup,
  cleanupRideKeys,
  setPendingLocation,
  getPendingLocation,
  clearPendingLocation,
  setBookingStage,
  getBookingStage,
  clearBookingStage,
  getBids,
  getLastBatch,
  storeLastBatch,
  setRideState,
  getRideMeta,
  storeAcceptedBid,
} from '../whatsapp-flows/bid-state';
import type { WhatsappBid } from '../whatsapp-flows/bid-state';
import {
  sendSearchingNotification,
  formatBidList,
} from '../whatsapp-flows/whatsapp-notifier';
import type { RedisClient } from '../redis/client';
import { readRawBody, sendJson } from './utils';

/** Stored in Redis when we've geocoded a ride but need to ask payment method. */
interface PendingPaymentChoice {
  rideId: string;
  riderId: string;
  phone: string;
  pickupLat: number;
  pickupLng: number;
  pickupAddress: string;
  pickupArea: string;
  destLat: number;
  destLng: number;
  destAddress: string;
  destArea: string;
  distanceKm: number;
  durationSeconds: number;
  suggestedFareNgn: number;
  finalOffer: number;
  minOfferNgn: number;
  ratePerKmNgn: number;
  route: unknown;
  createdAt: string;
}

const PENDING_PAYMENT_TTL = 300; // 5 minutes

function pendingPaymentKey(userId: string): string {
  return `whatsapp:pending_payment:${userId}`;
}

async function storePendingPayment(redis: RedisClient, userId: string, data: PendingPaymentChoice): Promise<void> {
  await redis.set(pendingPaymentKey(userId), JSON.stringify(data), PENDING_PAYMENT_TTL);
}

async function getPendingPayment(redis: RedisClient, userId: string): Promise<PendingPaymentChoice | null> {
  const raw = await redis.get(pendingPaymentKey(userId));
  if (!raw) return null;
  try { return JSON.parse(raw) as PendingPaymentChoice; } catch { return null; }
}

async function clearPendingPayment(redis: RedisClient, userId: string): Promise<void> {
  await redis.del(pendingPaymentKey(userId));
}

function parsePaymentChoice(message: string): 'CASH' | 'WALLET' | null {
  const lower = message.toLowerCase().trim();
  if (/\b(cash|pay\s*cash|cash\s*payment)\b/.test(lower)) return 'CASH';
  if (/\b(wallet|pay\s*wallet|wallet\s*payment|use\s*wallet|from\s*wallet)\b/.test(lower)) return 'WALLET';
  if (/^1$/.test(lower)) return 'CASH';
  if (/^2$/.test(lower)) return 'WALLET';
  return null;
}

export interface MetaWhatsappRouteDeps {
  jwtSecret: string;
  publisher: GatewayPublisher;
  pouchLiquifiaClient: PouchLiquifiaClient;
  redisClient: RedisClient;
  routePlanner: GoogleMapsRoutePlanner;
  googleMapsApiKey: string;
  metaAccessToken?: string;
  metaPhoneNumberId?: string;
  metaAppSecret?: string;
  metaWebhookVerifyToken?: string;
  groqApiKey?: string;
  groqModel: string;
  groqTimeoutMs: number;
  appBaseUrl?: string;
}

/* ─── Meta Cloud API helpers ─── */

function getHeaderValue(req: IncomingMessage, name: string): string | null {
  const value = req.headers[name.toLowerCase()];
  return typeof value === 'string' ? value : null;
}

function isValidMetaSignature(
  rawBody: Buffer,
  signature: string | null,
  appSecret: string | undefined,
): boolean {
  if (!appSecret) return true; // skip validation if no secret configured
  if (!signature) return false;

  // Meta sends: sha256=<hex>
  const expectedPrefix = 'sha256=';
  if (!signature.startsWith(expectedPrefix)) return false;

  const providedHash = signature.slice(expectedPrefix.length);
  const computedHash = createHmac('sha256', appSecret)
    .update(rawBody)
    .digest('hex');

  const left = Buffer.from(providedHash, 'utf8');
  const right = Buffer.from(computedHash, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

function normalizeMetaPhone(value: string | undefined): string | null {
  if (!value) return null;
  // Meta sends phone without '+', e.g. "2349012345678"
  const withPlus = value.startsWith('+') ? value : `+${value}`;
  if (!/^\+[1-9]\d{6,14}$/.test(withPlus)) return null;
  return withPlus;
}

async function sendMetaReply(
  deps: MetaWhatsappRouteDeps,
  to: string,
  message: string,
): Promise<void> {
  if (!deps.metaAccessToken || !deps.metaPhoneNumberId) {
    console.warn('[whatsapp] Cannot send reply — META_ACCESS_TOKEN or META_PHONE_NUMBER_ID not configured');
    return;
  }

  const recipient = to.replace(/^\+/, '');
  const endpoint = `https://graph.facebook.com/v21.0/${deps.metaPhoneNumberId}/messages`;

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${deps.metaAccessToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: recipient,
      type: 'text',
      text: { body: message },
    }),
  });

  if (!response.ok) {
    const payload = await response.text();
    console.error('[whatsapp] Meta reply failed', { status: response.status, payload });
  }
}

function sendOk(res: ServerResponse): void {
  res.statusCode = 200;
  res.setHeader('content-type', 'text/plain');
  res.end('OK');
}

/* ─── Webhook verification (GET) ─── */

export function handleMetaWhatsappVerify(
  req: IncomingMessage,
  res: ServerResponse,
  deps: MetaWhatsappRouteDeps,
): void {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const mode = url.searchParams.get('hub.mode');
  const token = url.searchParams.get('hub.verify_token');
  const challenge = url.searchParams.get('hub.challenge');

  console.info('[whatsapp] Verify attempt', { mode, token: token?.slice(0, 10), expected: deps.metaWebhookVerifyToken?.slice(0, 10) });
  if (mode === 'subscribe' && token === deps.metaWebhookVerifyToken) {
    console.info('[whatsapp] Webhook verified');
    res.statusCode = 200;
    res.setHeader('content-type', 'text/plain');
    res.end(challenge ?? '');
    return;
  }

  sendJson(res, 403, { error: 'Verification failed' });
}

/* ─── Extract message from Meta webhook payload ─── */

interface MetaMessageInfo {
  phone: string;
  profileName?: string;
  messageBody: string;
  isLocation: boolean;
  locationLat?: number;
  locationLng?: number;
}

function extractMetaMessage(body: unknown): MetaMessageInfo | null {
  const payload = body as Record<string, unknown>;
  if (payload.object !== 'whatsapp_business_account') return null;

  const entries = payload.entry as Array<Record<string, unknown>> | undefined;
  if (!entries?.length) return null;

  for (const entry of entries) {
    const changes = entry.changes as Array<Record<string, unknown>> | undefined;
    if (!changes?.length) continue;

    for (const change of changes) {
      const value = change.value as Record<string, unknown> | undefined;
      if (!value) continue;

      const messages = value.messages as Array<Record<string, unknown>> | undefined;
      if (!messages?.length) continue;

      const msg = messages[0];
      const from = msg.from as string | undefined;
      const phone = normalizeMetaPhone(from);
      if (!phone) continue;

      // Get profile name from contacts array
      const contacts = value.contacts as Array<Record<string, unknown>> | undefined;
      const profileName = contacts?.[0]?.profile
        ? (contacts[0].profile as Record<string, unknown>).name as string | undefined
        : undefined;

      // Handle location messages
      if (msg.type === 'location') {
        const location = msg.location as Record<string, unknown> | undefined;
        const lat = Number(location?.latitude);
        const lng = Number(location?.longitude);
        return {
          phone,
          profileName,
          messageBody: `[Location: ${lat},${lng}]`,
          isLocation: true,
          locationLat: lat,
          locationLng: lng,
        };
      }

      // Handle text messages
      if (msg.type === 'text') {
        const text = msg.text as Record<string, unknown> | undefined;
        return {
          phone,
          profileName,
          messageBody: (text?.body as string | undefined)?.trim() ?? '',
          isLocation: false,
        };
      }

      // Handle interactive messages (button replies, list replies)
      if (msg.type === 'interactive') {
        const interactive = msg.interactive as Record<string, unknown> | undefined;
        if (interactive?.type === 'button_reply') {
          const buttonReply = interactive.button_reply as Record<string, unknown>;
          return {
            phone,
            profileName,
            messageBody: (buttonReply?.title as string) ?? '',
            isLocation: false,
          };
        }
        if (interactive?.type === 'list_reply') {
          const listReply = interactive.list_reply as Record<string, unknown>;
          return {
            phone,
            profileName,
            messageBody: (listReply?.title as string) ?? '',
            isLocation: false,
          };
        }
      }

      // Default: treat as empty
      return { phone, profileName, messageBody: '', isLocation: false };
    }
  }

  return null;
}

/* ─── Parse bid commands from user text ─── */

function parseAcceptCommand(message: string): number | null {
  const match = message.match(/^accept\s+(\d+)$/i);
  if (match) return parseInt(match[1], 10);
  return null;
}

function parseCounterOffer(message: string): number | null {
  const lower = message.toLowerCase().trim();
  // Match plain numbers like "1500", "2000"
  const numMatch = lower.match(/^(\d{3,6})$/);
  if (numMatch) return parseInt(numMatch[1], 10);
  // Match "₦1500", "N1500"
  const currMatch = lower.match(/^[₦n]\s*(\d{3,6})$/);
  if (currMatch) return parseInt(currMatch[1], 10);
  // Match "1.5k", "2k"
  const kMatch = lower.match(/^(\d+(?:\.\d+)?)\s*k$/);
  if (kMatch) return Math.round(parseFloat(kMatch[1]) * 1000);
  return null;
}

function isMoreCommand(message: string): boolean {
  return /^(more|more\s+drivers|refresh|next)$/i.test(message.trim());
}

function isCancelCommand(message: string): boolean {
  return /^(cancel|cancel\s*(my\s*)?ride|stop\s*(my\s*)?ride)$/i.test(message.trim());
}

/* ─── Create and publish a ride ─── */

async function createAndPublishRide(
  deps: MetaWhatsappRouteDeps,
  userId: string,
  phone: string,
  pickup: { lat: number; lng: number; address: string },
  destination: { lat: number; lng: number; address: string },
  paymentMethod: 'CASH' | 'WALLET',
  offerOverride?: number,
): Promise<{ rideId: string; finalOffer: number; suggestedFareNgn: number }> {
  const plannedRoute = await deps.routePlanner.planRoute({
    origin: pickup,
    destination,
  });

  const rideId = randomUUID();
  const suggestedFareNgn = plannedRoute.suggestedFareNgn;
  const riderOfferNgn = offerOverride ?? suggestedFareNgn;
  const validation = validateRiderOffer(riderOfferNgn, suggestedFareNgn);
  const finalOffer = validation.valid ? riderOfferNgn : suggestedFareNgn;

  // Handle wallet payment
  if (paymentMethod === 'WALLET') {
    const wallet = await walletClient.findByUserId(userId);
    if (wallet && Number(wallet.balanceNgn) >= finalOffer) {
      try {
        await walletClient.createRideHold({ rideId, walletId: wallet.id, riderId: userId, amountNgn: finalOffer });
      } catch {
        // Fall through — will use cash
      }
    }
  }

  const event = RideRequestedEvent.parse({
    eventType: 'RIDE_REQUESTED',
    rideId,
    riderId: userId,
    pickup: { lat: pickup.lat, lng: pickup.lng, address: pickup.address },
    destination: { lat: destination.lat, lng: destination.lng, address: destination.address },
    stops: [],
    plannedDistanceKm: plannedRoute.distanceKm,
    plannedDurationSeconds: plannedRoute.durationSeconds,
    fareEstimateNgn: suggestedFareNgn,
    paymentMethod,
    riderOfferNgn: finalOffer,
    suggestedFareNgn,
    minOfferNgn: plannedRoute.minOfferNgn,
    ratePerKmNgn: plannedRoute.ratePerKmNgn,
    route: plannedRoute.geometry,
    timestamp: new Date().toISOString(),
  });

  await deps.publisher.publishRideEvent(event);

  await storeWhatsappRide(deps.redisClient, rideId, {
    riderId: userId,
    phone,
    pickupAddress: pickup.address,
    pickupLat: pickup.lat,
    pickupLng: pickup.lng,
    destinationAddress: destination.address,
    destinationLat: destination.lat,
    destinationLng: destination.lng,
    distanceKm: plannedRoute.distanceKm,
    durationSeconds: plannedRoute.durationSeconds,
    offerNgn: finalOffer,
    suggestedFareNgn,
    paymentMethod,
    createdAt: new Date().toISOString(),
  });
  await setActiveRide(deps.redisClient, userId, rideId);

  return { rideId, finalOffer, suggestedFareNgn };
}

/* ─── Main POST webhook handler ─── */

export async function handleMetaWhatsappWebhookRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: MetaWhatsappRouteDeps,
): Promise<void> {
  try {
    const rawBody = await readRawBody(req);

    if (!isValidMetaSignature(rawBody, getHeaderValue(req, 'x-hub-signature-256'), deps.metaAppSecret)) {
      sendJson(res, 403, { error: 'Invalid signature' });
      return;
    }

    // Always respond 200 quickly — Meta requires fast acknowledgement
    sendOk(res);

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody.toString('utf8'));
    } catch {
      console.warn('[whatsapp] Invalid JSON in Meta webhook');
      return;
    }

    // Meta sends status updates (delivered, read) — ignore them
    const msgInfo = extractMetaMessage(parsed);
    if (!msgInfo) return;

    const { phone, profileName, messageBody: incomingMessage, isLocation, locationLat, locationLng } = msgInfo;

    const user = await onboardWhatsappUser({
      phone,
      profileName,
      deps: {
        jwtSecret: deps.jwtSecret,
        publisher: deps.publisher,
        pouchLiquifiaClient: deps.pouchLiquifiaClient,
      },
    });

    // Store phone lookup for Kafka consumer notifications
    await setPhoneLookup(deps.redisClient, user.id, phone).catch(() => {});

    const activeRideId = await getActiveRide(deps.redisClient, user.id);
    const bookingStage = await getBookingStage(deps.redisClient, user.id);

    // ══════════════════════════════════════════════════════════════════════
    // 1. ACTIVE RIDE — handle accept/counter/more/cancel commands
    // ══════════════════════════════════════════════════════════════════════

    if (activeRideId && !isLocation) {
      // ── Cancel command ──
      if (isCancelCommand(incomingMessage)) {
        const cancelEvent = RideCancelledEvent.parse({
          eventType: 'RIDE_CANCELLED',
          rideId: activeRideId,
          riderId: user.id,
          reason: 'rider_cancelled',
          timestamp: new Date().toISOString(),
        });
        await deps.publisher.publishRideEvent(cancelEvent);
        await clearActiveRide(deps.redisClient, user.id);
        await cleanupRideKeys(deps.redisClient, activeRideId);
        await clearBookingStage(deps.redisClient, user.id);

        const reply = 'Ride cancelled. Share your location anytime to book a new ride! 📍';
        await appendWhatsappConversation(deps.redisClient, phone, [
          { role: 'user', content: incomingMessage },
          { role: 'assistant', content: reply },
        ]);
        await sendMetaReply(deps, phone, reply);
        return;
      }

      // ── Accept a driver: "accept 1", "accept 3" ──
      const acceptNum = parseAcceptCommand(incomingMessage);
      if (acceptNum !== null) {
        const lastBatch = await getLastBatch(deps.redisClient, activeRideId);
        const bidIndex = acceptNum - 1; // 1-indexed to 0-indexed
        const selectedBid = lastBatch[bidIndex];

        if (!selectedBid) {
          const reply = `Invalid driver number. Reply with a number from 1 to ${lastBatch.length}.`;
          await appendWhatsappConversation(deps.redisClient, phone, [
            { role: 'user', content: incomingMessage },
            { role: 'assistant', content: reply },
          ]);
          await sendMetaReply(deps, phone, reply);
          return;
        }

        // Accept this bid
        const meta = await getRideMeta(deps.redisClient, activeRideId);
        const acceptEvent = RideOfferAcceptedEvent.parse({
          eventType: 'RIDE_OFFER_ACCEPTED',
          rideId: activeRideId,
          riderId: user.id,
          driverId: selectedBid.driverId,
          driverUserId: selectedBid.driverUserId,
          agreedFareNgn: selectedBid.counterOfferNgn,
          paymentMethod: meta?.paymentMethod ?? 'CASH',
          timestamp: new Date().toISOString(),
        });
        await deps.publisher.publishRideEvent(acceptEvent);
        await setRideState(deps.redisClient, activeRideId, 'confirmed');

        // Store accepted bid info
        try {
          const driver = await driverClient.findById(selectedBid.driverId);
          await storeAcceptedBid(deps.redisClient, activeRideId, {
            driverName: selectedBid.driverName,
            driverPhone: driver.user.phone ?? '',
            driverUserId: selectedBid.driverUserId,
            vehicleModel: selectedBid.vehicleModel,
            vehiclePlate: selectedBid.vehiclePlate,
            vehicleColor: '',
            driverRating: selectedBid.driverRating,
            totalRides: driver.totalRides ?? 0,
            etaSeconds: selectedBid.etaSeconds,
            fareNgn: selectedBid.counterOfferNgn,
          });
        } catch {
          // Non-critical
        }

        const etaMin = Math.ceil(selectedBid.etaSeconds / 60);
        const reply = [
          `✅ *Ride confirmed!*`,
          ``,
          `Driver: *${selectedBid.driverName}*`,
          `Vehicle: ${selectedBid.vehicleModel} (${selectedBid.vehiclePlate})`,
          `Rating: ${selectedBid.driverRating.toFixed(1)}★`,
          `ETA: ${etaMin} min`,
          `Fare: ₦${selectedBid.counterOfferNgn.toLocaleString()}`,
          ``,
          `Your driver is on the way! 🚗`,
        ].join('\n');

        await appendWhatsappConversation(deps.redisClient, phone, [
          { role: 'user', content: incomingMessage },
          { role: 'assistant', content: reply },
        ]);
        await sendMetaReply(deps, phone, reply);
        return;
      }

      // ── "more" command — show latest bids ──
      if (isMoreCommand(incomingMessage)) {
        const allBids = await getBids(deps.redisClient, activeRideId);
        const meta = await getRideMeta(deps.redisClient, activeRideId);

        if (allBids.length === 0) {
          const reply = 'Still looking for drivers... I\'ll message you when they respond! 🔍';
          await appendWhatsappConversation(deps.redisClient, phone, [
            { role: 'user', content: incomingMessage },
            { role: 'assistant', content: reply },
          ]);
          await sendMetaReply(deps, phone, reply);
          return;
        }

        await storeLastBatch(deps.redisClient, activeRideId, allBids);
        const reply = formatBidList(allBids, meta?.offerNgn ?? 0);
        await appendWhatsappConversation(deps.redisClient, phone, [
          { role: 'user', content: incomingMessage },
          { role: 'assistant', content: reply },
        ]);
        await sendMetaReply(deps, phone, reply);
        return;
      }

      // ── Counter-offer with a price: "1500", "₦2000", "2k" ──
      const counterOffer = parseCounterOffer(incomingMessage);
      if (counterOffer !== null) {
        const meta = await getRideMeta(deps.redisClient, activeRideId);
        if (meta) {
          // Update the rider's offer in Redis
          meta.offerNgn = counterOffer;
          await deps.redisClient.set(
            `whatsapp:ride:${activeRideId}:meta`,
            JSON.stringify(meta),
            900,
          );

          // Show current bids with updated price context
          const allBids = await getBids(deps.redisClient, activeRideId);
          if (allBids.length > 0) {
            await storeLastBatch(deps.redisClient, activeRideId, allBids);
            const reply = `Your offer updated to ₦${counterOffer.toLocaleString()}!\n\n${formatBidList(allBids, counterOffer)}`;
            await appendWhatsappConversation(deps.redisClient, phone, [
              { role: 'user', content: incomingMessage },
              { role: 'assistant', content: reply },
            ]);
            await sendMetaReply(deps, phone, reply);
          } else {
            const reply = `Your offer updated to ₦${counterOffer.toLocaleString()}. Still searching for drivers... 🔍`;
            await appendWhatsappConversation(deps.redisClient, phone, [
              { role: 'user', content: incomingMessage },
              { role: 'assistant', content: reply },
            ]);
            await sendMetaReply(deps, phone, reply);
          }
          return;
        }
      }

      // ── Active ride but unrecognized command — remind them ──
      const reply = 'You have an active ride. Reply:\n• *accept 1* — to accept a driver\n• A *price* (e.g. "2000") — to counter-offer\n• *more* — to see drivers\n• *cancel* — to cancel';
      await appendWhatsappConversation(deps.redisClient, phone, [
        { role: 'user', content: incomingMessage },
        { role: 'assistant', content: reply },
      ]);
      await sendMetaReply(deps, phone, reply);
      return;
    }

    // ══════════════════════════════════════════════════════════════════════
    // 2. LOCATION PIN — handle pickup and destination location shares
    // ══════════════════════════════════════════════════════════════════════

    if (isLocation && locationLat !== undefined && locationLng !== undefined && !isNaN(locationLat) && !isNaN(locationLng)) {
      const reverseGeo = await reverseGeocode(deps.googleMapsApiKey, locationLat, locationLng);
      const address = reverseGeo?.formattedAddress ?? `${locationLat.toFixed(4)}, ${locationLng.toFixed(4)}`;

      const pendingPickup = await getPendingLocation(deps.redisClient, user.id);

      if (!pendingPickup) {
        // ── FIRST location pin = PICKUP ──
        await setPendingLocation(deps.redisClient, user.id, {
          lat: locationLat,
          lng: locationLng,
          address,
          savedAt: new Date().toISOString(),
        });
        await setBookingStage(deps.redisClient, user.id, 'awaiting_destination');

        const reply = `📍 Pickup: *${address}*\n\nNow share your *destination* location pin! 📍`;
        await appendWhatsappConversation(deps.redisClient, phone, [
          { role: 'user', content: `[Shared pickup location: ${address}]` },
          { role: 'assistant', content: reply },
        ]);
        await sendMetaReply(deps, phone, reply);
        return;
      }

      // ── SECOND location pin = DESTINATION ──
      // We have pickup, now got destination
      const pickup = { lat: pendingPickup.lat, lng: pendingPickup.lng, address: pendingPickup.address };
      const destination = { lat: locationLat, lng: locationLng, address };

      await clearPendingLocation(deps.redisClient, user.id);
      await clearBookingStage(deps.redisClient, user.id);

      // Check for existing active ride
      if (activeRideId) {
        const reply = 'You already have an active ride. Say *cancel* first to book a new one.';
        await appendWhatsappConversation(deps.redisClient, phone, [
          { role: 'user', content: `[Shared destination location: ${address}]` },
          { role: 'assistant', content: reply },
        ]);
        await sendMetaReply(deps, phone, reply);
        return;
      }

      // Ask for payment method
      const plannedRoute = await deps.routePlanner.planRoute({ origin: pickup, destination });
      const distanceKm = plannedRoute.distanceKm;
      const durationMin = Math.ceil(plannedRoute.durationSeconds / 60);
      const suggestedFare = plannedRoute.suggestedFareNgn;

      const rideId = randomUUID();
      await storePendingPayment(deps.redisClient, user.id, {
        rideId,
        riderId: user.id,
        phone,
        pickupLat: pickup.lat,
        pickupLng: pickup.lng,
        pickupAddress: pickup.address,
        pickupArea: pickup.address,
        destLat: destination.lat,
        destLng: destination.lng,
        destAddress: destination.address,
        destArea: destination.address,
        distanceKm: plannedRoute.distanceKm,
        durationSeconds: plannedRoute.durationSeconds,
        suggestedFareNgn: suggestedFare,
        finalOffer: suggestedFare,
        minOfferNgn: plannedRoute.minOfferNgn,
        ratePerKmNgn: plannedRoute.ratePerKmNgn,
        route: plannedRoute.geometry,
        createdAt: new Date().toISOString(),
      });
      await setBookingStage(deps.redisClient, user.id, 'awaiting_payment');

      const reply = [
        `📍 *${pickup.address}*`,
        `📍 *${destination.address}*`,
        ``,
        `${distanceKm.toFixed(1)} km · ~${durationMin} min`,
        `Suggested fare: ₦${suggestedFare.toLocaleString()}`,
        ``,
        `How would you like to pay?`,
        ``,
        `*1.* Cash 💵`,
        `*2.* Wallet 💰`,
        ``,
        `Reply *cash* or *wallet*`,
      ].join('\n');

      await appendWhatsappConversation(deps.redisClient, phone, [
        { role: 'user', content: `[Shared destination location: ${address}]` },
        { role: 'assistant', content: reply },
      ]);
      await sendMetaReply(deps, phone, reply);
      return;
    }

    // ══════════════════════════════════════════════════════════════════════
    // 3. AWAITING DESTINATION — user sent text instead of location pin
    // ══════════════════════════════════════════════════════════════════════

    if (bookingStage === 'awaiting_destination' && !isLocation) {
      const reply = 'Please share your *destination* as a location pin! 📍\n\nTap the attachment (📎) button → Location → Share your destination.';
      await appendWhatsappConversation(deps.redisClient, phone, [
        { role: 'user', content: incomingMessage },
        { role: 'assistant', content: reply },
      ]);
      await sendMetaReply(deps, phone, reply);
      return;
    }

    // ══════════════════════════════════════════════════════════════════════
    // 4. PAYMENT METHOD — user is choosing cash/wallet
    // ══════════════════════════════════════════════════════════════════════

    const pendingPayment = await getPendingPayment(deps.redisClient, user.id);
    if (pendingPayment) {
      const paymentChoice = parsePaymentChoice(incomingMessage);
      if (paymentChoice) {
        await clearPendingPayment(deps.redisClient, user.id);
        await clearBookingStage(deps.redisClient, user.id);

        if (paymentChoice === 'WALLET') {
          const wallet = await walletClient.findByUserId(user.id);
          if (!wallet || Number(wallet.balanceNgn) < pendingPayment.finalOffer) {
            const balance = wallet ? `₦${Number(wallet.balanceNgn).toLocaleString()}` : '₦0';
            const reply = `Your wallet balance is ${balance} but the ride costs ₦${pendingPayment.finalOffer.toLocaleString()}. Would you like to pay with *cash* instead?\n\nReply *cash* or *wallet* after topping up.`;
            await appendWhatsappConversation(deps.redisClient, phone, [
              { role: 'user', content: incomingMessage },
              { role: 'assistant', content: reply },
            ]);
            await storePendingPayment(deps.redisClient, user.id, pendingPayment);
            await sendMetaReply(deps, phone, reply);
            return;
          }

          try {
            await walletClient.createRideHold({
              rideId: pendingPayment.rideId,
              walletId: wallet.id,
              riderId: user.id,
              amountNgn: pendingPayment.finalOffer,
            });
          } catch (holdError) {
            console.warn('[whatsapp] Wallet hold failed', holdError);
            const reply = `Could not lock funds in your wallet. Would you like to pay with *cash* instead?`;
            await appendWhatsappConversation(deps.redisClient, phone, [
              { role: 'user', content: incomingMessage },
              { role: 'assistant', content: reply },
            ]);
            await storePendingPayment(deps.redisClient, user.id, pendingPayment);
            await sendMetaReply(deps, phone, reply);
            return;
          }
        }

        // Create the ride
        const event = RideRequestedEvent.parse({
          eventType: 'RIDE_REQUESTED',
          rideId: pendingPayment.rideId,
          riderId: user.id,
          pickup: { lat: pendingPayment.pickupLat, lng: pendingPayment.pickupLng, address: pendingPayment.pickupAddress },
          destination: { lat: pendingPayment.destLat, lng: pendingPayment.destLng, address: pendingPayment.destAddress },
          stops: [],
          plannedDistanceKm: pendingPayment.distanceKm,
          plannedDurationSeconds: pendingPayment.durationSeconds,
          fareEstimateNgn: pendingPayment.suggestedFareNgn,
          paymentMethod: paymentChoice,
          riderOfferNgn: pendingPayment.finalOffer,
          suggestedFareNgn: pendingPayment.suggestedFareNgn,
          minOfferNgn: pendingPayment.minOfferNgn,
          ratePerKmNgn: pendingPayment.ratePerKmNgn,
          route: pendingPayment.route,
          timestamp: new Date().toISOString(),
        });

        await deps.publisher.publishRideEvent(event);

        await storeWhatsappRide(deps.redisClient, pendingPayment.rideId, {
          riderId: user.id,
          phone,
          pickupAddress: pendingPayment.pickupAddress,
          pickupLat: pendingPayment.pickupLat,
          pickupLng: pendingPayment.pickupLng,
          destinationAddress: pendingPayment.destAddress,
          destinationLat: pendingPayment.destLat,
          destinationLng: pendingPayment.destLng,
          distanceKm: pendingPayment.distanceKm,
          durationSeconds: pendingPayment.durationSeconds,
          offerNgn: pendingPayment.finalOffer,
          suggestedFareNgn: pendingPayment.suggestedFareNgn,
          paymentMethod: paymentChoice,
          createdAt: new Date().toISOString(),
        });
        await setActiveRide(deps.redisClient, user.id, pendingPayment.rideId);

        if (deps.metaAccessToken && deps.metaPhoneNumberId) {
          await sendSearchingNotification(
            { metaAccessToken: deps.metaAccessToken, metaPhoneNumberId: deps.metaPhoneNumberId },
            phone,
            pendingPayment.pickupAddress,
            pendingPayment.destAddress,
            pendingPayment.finalOffer,
            paymentChoice,
          );
        }

        await appendWhatsappConversation(deps.redisClient, phone, [
          { role: 'user', content: incomingMessage },
          { role: 'assistant', content: 'Looking for drivers...' },
        ]);
        return;
      }

      // User didn't say cash/wallet — remind them
      const reply = `Please choose a payment method:\n\n*1.* Cash 💵\n*2.* Wallet 💰\n\nReply *cash* or *wallet*`;
      await appendWhatsappConversation(deps.redisClient, phone, [
        { role: 'user', content: incomingMessage },
        { role: 'assistant', content: reply },
      ]);
      await sendMetaReply(deps, phone, reply);
      return;
    }

    // ══════════════════════════════════════════════════════════════════════
    // 5. CANCEL RIDE (via LLM intent or direct text, no active ride)
    // ══════════════════════════════════════════════════════════════════════

    if (isCancelCommand(incomingMessage)) {
      // Clear any pending state
      await clearPendingLocation(deps.redisClient, user.id);
      await clearBookingStage(deps.redisClient, user.id);

      const reply = 'Nothing to cancel. Share your location to book a ride! 📍';
      await appendWhatsappConversation(deps.redisClient, phone, [
        { role: 'user', content: incomingMessage },
        { role: 'assistant', content: reply },
      ]);
      await sendMetaReply(deps, phone, reply);
      return;
    }

    // ══════════════════════════════════════════════════════════════════════
    // 6. NO ACTIVE RIDE, NO PENDING STATE — AI conversation / ride intent
    // ══════════════════════════════════════════════════════════════════════

    const recentMessages = await getWhatsappConversation(deps.redisClient, phone);

    const groq = new GroqClient({
      apiKey: deps.groqApiKey,
      model: deps.groqModel,
      timeoutMs: deps.groqTimeoutMs,
    });

    // Try to parse ride intent
    const rideIntent = await parseRideIntent(groq, incomingMessage, recentMessages);

    if (rideIntent?.intent === 'ride_request') {
      // User wants a ride but hasn't shared location — tell them to share location pin
      const reply = 'To book a ride, share your *pickup location* as a location pin! 📍\n\nTap the attachment (📎) button → Location → Send your current location.';
      await appendWhatsappConversation(deps.redisClient, phone, [
        { role: 'user', content: incomingMessage },
        { role: 'assistant', content: reply },
      ]);
      await sendMetaReply(deps, phone, reply);
      return;
    }

    // AI response for general messages
    const bot = new WhatsappBotService({
      apiKey: deps.groqApiKey,
      model: deps.groqModel,
      timeoutMs: deps.groqTimeoutMs,
      jwtSecret: deps.jwtSecret,
      appBaseUrl: deps.appBaseUrl,
    });
    const reply = await bot.generateReply({
      userId: user.id,
      phone,
      profileName,
      incomingMessage,
      isNewUser: user.created,
      recentMessages,
    });

    await appendWhatsappConversation(deps.redisClient, phone, [
      { role: 'user', content: incomingMessage || '[empty message]' },
      { role: 'assistant', content: reply },
    ]);

    await sendMetaReply(deps, phone, reply);
  } catch (error) {
    console.error('[whatsapp] webhook handling failed', error);
    // Don't try to send error — we already responded 200
  }
}
