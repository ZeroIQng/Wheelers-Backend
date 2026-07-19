import { createHmac, randomUUID, timingSafeEqual } from 'crypto';
import type { IncomingMessage, ServerResponse } from 'http';
import { userClient, walletClient } from '@wheleers/db';
import { GoogleMapsRoutePlanner, validateRiderOffer } from '@wheleers/config';
import { RideRequestedEvent, RideCancelledEvent, TOPICS } from '@wheleers/kafka-schemas';
import type { PouchLiquifiaClient } from '@wheleers/pouch-client';
import type { GatewayPublisher } from '../websocket/publisher';
import { createLocalAccessToken } from '../auth/local';
import { onboardWhatsappUser } from '../onboarding/user-onboarding';
import {
  appendWhatsappConversation,
  getWhatsappConversation,
} from '../LLM/conversation-store';
import { WhatsappBotService } from '../LLM/whatsapp-bot.service';
import { GroqClient } from '../LLM/groq.client';
import { parseRideIntent } from '../LLM/ride-intent-parser';
import { geocodeAddress } from '../LLM/geocoding';
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
} from '../whatsapp-flows/bid-state';
import { sendBookRideFlowMessage } from '../whatsapp-flows/whatsapp-notifier';
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
  flowId?: string;
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
}

function extractMetaMessage(body: unknown): MetaMessageInfo | null {
  // Meta webhook payload structure:
  // { object: "whatsapp_business_account", entry: [{ changes: [{ value: { messages: [...], contacts: [...] } }] }] }
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

      // Handle text messages
      if (msg.type === 'text') {
        const text = msg.text as Record<string, unknown> | undefined;
        return {
          phone,
          profileName,
          messageBody: (text?.body as string | undefined)?.trim() ?? '',
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
          };
        }
        if (interactive?.type === 'list_reply') {
          const listReply = interactive.list_reply as Record<string, unknown>;
          return {
            phone,
            profileName,
            messageBody: (listReply?.title as string) ?? '',
          };
        }
      }

      // Handle location messages
      if (msg.type === 'location') {
        const location = msg.location as Record<string, unknown> | undefined;
        return {
          phone,
          profileName,
          messageBody: `[Location: ${location?.latitude},${location?.longitude}]`,
        };
      }

      // Default: treat as empty
      return { phone, profileName, messageBody: '' };
    }
  }

  return null;
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

    const { phone, profileName, messageBody: incomingMessage } = msgInfo;

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

    // ── Handle location pin shares ──────────────────────────────────────
    const locationMatch = incomingMessage.match(/^\[Location:\s*([-\d.]+),([-\d.]+)\]$/);
    if (locationMatch) {
      const lat = parseFloat(locationMatch[1]);
      const lng = parseFloat(locationMatch[2]);

      if (!isNaN(lat) && !isNaN(lng)) {
        // Reverse geocode to get address
        const reverseGeo = await geocodeAddress(deps.googleMapsApiKey, `${lat},${lng}`);
        const address = reverseGeo?.formattedAddress ?? `${lat.toFixed(4)}, ${lng.toFixed(4)}`;

        await setPendingLocation(deps.redisClient, user.id, {
          lat,
          lng,
          address,
          savedAt: new Date().toISOString(),
        });

        const reply = `Got it — *${address}*\n\nWhere are you headed? Type a destination (street, landmark, bus stop) or share another location pin 📍`;
        await appendWhatsappConversation(deps.redisClient, phone, [
          { role: 'user', content: `[Shared location: ${address}]` },
          { role: 'assistant', content: reply },
        ]);
        await sendMetaReply(deps, phone, reply);
        return;
      }
    }

    const recentMessages = await getWhatsappConversation(deps.redisClient, phone);

    // ── Check if we have a pending pickup location and this is the destination ──
    const pendingLocation = await getPendingLocation(deps.redisClient, user.id);
    if (pendingLocation && incomingMessage && !incomingMessage.startsWith('[')) {
      // User just shared location, now they're typing the destination
      const existingRide = await getActiveRide(deps.redisClient, user.id);
      if (!existingRide) {
        const destGeo = await geocodeAddress(deps.googleMapsApiKey, `${incomingMessage}, Lagos, Nigeria`);
        if (destGeo) {
          const plannedRoute = await deps.routePlanner.planRoute({
            origin: { lat: pendingLocation.lat, lng: pendingLocation.lng },
            destination: destGeo,
          });

          const distanceKm = plannedRoute.distanceKm;
          const durationMin = Math.ceil(plannedRoute.durationSeconds / 60);
          const suggestedFare = `₦${plannedRoute.suggestedFareNgn.toLocaleString()}`;

          const routeSummary = `*${pendingLocation.address}* → *${destGeo.formattedAddress}*\n${distanceKm.toFixed(1)} km · ~${durationMin} min\nSuggested fare: ${suggestedFare}`;

          // Send flow button to open the booking flow
          if (deps.metaAccessToken && deps.metaPhoneNumberId) {
            await sendBookRideFlowMessage(
              {
                metaAccessToken: deps.metaAccessToken,
                metaPhoneNumberId: deps.metaPhoneNumberId,
                tokenSecret: deps.jwtSecret,
                flowId: deps.flowId,
              },
              phone,
              user.id,
              routeSummary,
            );
          } else {
            await sendMetaReply(deps, phone, `${routeSummary}\n\nSend your offer amount to book!`);
          }

          await appendWhatsappConversation(deps.redisClient, phone, [
            { role: 'user', content: incomingMessage },
            { role: 'assistant', content: routeSummary },
          ]);
          return;
        }
        // Geocoding failed — fall through to normal handling
      }
    }

    // Check if the user is replying to a payment method question
    const pendingPayment = await getPendingPayment(deps.redisClient, user.id);
    if (pendingPayment) {
      const paymentChoice = parsePaymentChoice(incomingMessage);
      if (paymentChoice) {
        await clearPendingPayment(deps.redisClient, user.id);

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
          destinationAddress: pendingPayment.destAddress,
          offerNgn: pendingPayment.finalOffer,
          suggestedFareNgn: pendingPayment.suggestedFareNgn,
          paymentMethod: paymentChoice,
          createdAt: new Date().toISOString(),
        });
        await setActiveRide(deps.redisClient, user.id, pendingPayment.rideId);

        const offerDisplay = `₦${pendingPayment.finalOffer.toLocaleString()}`;
        const payLabel = paymentChoice === 'WALLET' ? 'Wallet (funds locked)' : 'Cash';
        const reply = `Looking for drivers from *${pendingPayment.pickupArea}* to *${pendingPayment.destArea}*!\n\nOffer: ${offerDisplay}\nPayment: ${payLabel}\n\nI'll message you when drivers respond 🚗`;
        await appendWhatsappConversation(deps.redisClient, phone, [
          { role: 'user', content: incomingMessage },
          { role: 'assistant', content: reply },
        ]);
        await sendMetaReply(deps, phone, reply);
        return;
      }
      // User didn't say cash/wallet — remind them
      const reply = `Please choose a payment method:\n\n*1.* Cash\n*2.* Wallet\n\nReply *cash* or *wallet*`;
      await appendWhatsappConversation(deps.redisClient, phone, [
        { role: 'user', content: incomingMessage },
        { role: 'assistant', content: reply },
      ]);
      await sendMetaReply(deps, phone, reply);
      return;
    }

    const groq = new GroqClient({
      apiKey: deps.groqApiKey,
      model: deps.groqModel,
      timeoutMs: deps.groqTimeoutMs,
    });

    // Try to parse ride intent before falling through to AI conversation
    const rideIntent = await parseRideIntent(groq, incomingMessage, recentMessages);

    if (rideIntent?.intent === 'ride_request' && rideIntent.pickup && rideIntent.destination
        && rideIntent.pickup.specific && rideIntent.destination.specific) {
      const existingRide = await getActiveRide(deps.redisClient, user.id);
      if (existingRide) {
        const reply = "You already have an active ride request. I'll notify you when drivers respond, or say 'cancel ride' to cancel.";
        await appendWhatsappConversation(deps.redisClient, phone, [
          { role: 'user', content: incomingMessage },
          { role: 'assistant', content: reply },
        ]);
        await sendMetaReply(deps, phone, reply);
        return;
      }

      const [pickupGeo, destGeo] = await Promise.all([
        geocodeAddress(deps.googleMapsApiKey, rideIntent.pickup.address),
        geocodeAddress(deps.googleMapsApiKey, rideIntent.destination.address),
      ]);

      if (pickupGeo && destGeo) {
        const plannedRoute = await deps.routePlanner.planRoute({
          origin: pickupGeo,
          destination: destGeo,
        });

        const rideId = randomUUID();
        const suggestedFareNgn = plannedRoute.suggestedFareNgn;
        const riderOfferNgn = rideIntent.offerNgn ?? suggestedFareNgn;

        const validation = validateRiderOffer(riderOfferNgn, suggestedFareNgn);
        const finalOffer = validation.valid ? riderOfferNgn : suggestedFareNgn;

        // If user already said payment method in their message, skip the question
        if (rideIntent.paymentMethod) {
          const paymentMethod: 'CASH' | 'WALLET' = rideIntent.paymentMethod === 'CASH' ? 'CASH' : 'WALLET';

          if (paymentMethod === 'WALLET') {
            const wallet = await walletClient.findByUserId(user.id);
            if (!wallet || Number(wallet.balanceNgn) < finalOffer) {
              const balance = wallet ? `₦${Number(wallet.balanceNgn).toLocaleString()}` : '₦0';
              await storePendingPayment(deps.redisClient, user.id, {
                rideId, riderId: user.id, phone,
                pickupLat: pickupGeo.lat, pickupLng: pickupGeo.lng, pickupAddress: pickupGeo.formattedAddress, pickupArea: rideIntent.pickup.area,
                destLat: destGeo.lat, destLng: destGeo.lng, destAddress: destGeo.formattedAddress, destArea: rideIntent.destination.area,
                distanceKm: plannedRoute.distanceKm, durationSeconds: plannedRoute.durationSeconds,
                suggestedFareNgn, finalOffer, minOfferNgn: plannedRoute.minOfferNgn, ratePerKmNgn: plannedRoute.ratePerKmNgn,
                route: plannedRoute.geometry, createdAt: new Date().toISOString(),
              });
              const reply = `Your wallet balance is ${balance} but the ride costs ₦${finalOffer.toLocaleString()}. Would you like to pay with *cash* instead?\n\nReply *cash* or *wallet* after topping up.`;
              await appendWhatsappConversation(deps.redisClient, phone, [
                { role: 'user', content: incomingMessage },
                { role: 'assistant', content: reply },
              ]);
              await sendMetaReply(deps, phone, reply);
              return;
            }

            try {
              await walletClient.createRideHold({ rideId, walletId: wallet.id, riderId: user.id, amountNgn: finalOffer });
            } catch {
              await storePendingPayment(deps.redisClient, user.id, {
                rideId, riderId: user.id, phone,
                pickupLat: pickupGeo.lat, pickupLng: pickupGeo.lng, pickupAddress: pickupGeo.formattedAddress, pickupArea: rideIntent.pickup.area,
                destLat: destGeo.lat, destLng: destGeo.lng, destAddress: destGeo.formattedAddress, destArea: rideIntent.destination.area,
                distanceKm: plannedRoute.distanceKm, durationSeconds: plannedRoute.durationSeconds,
                suggestedFareNgn, finalOffer, minOfferNgn: plannedRoute.minOfferNgn, ratePerKmNgn: plannedRoute.ratePerKmNgn,
                route: plannedRoute.geometry, createdAt: new Date().toISOString(),
              });
              const reply = `Could not lock funds in your wallet. Would you like to pay with *cash* instead?\n\nReply *cash* or *wallet*`;
              await appendWhatsappConversation(deps.redisClient, phone, [
                { role: 'user', content: incomingMessage },
                { role: 'assistant', content: reply },
              ]);
              await sendMetaReply(deps, phone, reply);
              return;
            }
          }

          const event = RideRequestedEvent.parse({
            eventType: 'RIDE_REQUESTED', rideId, riderId: user.id,
            pickup: { lat: pickupGeo.lat, lng: pickupGeo.lng, address: pickupGeo.formattedAddress },
            destination: { lat: destGeo.lat, lng: destGeo.lng, address: destGeo.formattedAddress },
            stops: [], plannedDistanceKm: plannedRoute.distanceKm, plannedDurationSeconds: plannedRoute.durationSeconds,
            fareEstimateNgn: suggestedFareNgn, paymentMethod, riderOfferNgn: finalOffer, suggestedFareNgn,
            minOfferNgn: plannedRoute.minOfferNgn, ratePerKmNgn: plannedRoute.ratePerKmNgn,
            route: plannedRoute.geometry, timestamp: new Date().toISOString(),
          });
          await deps.publisher.publishRideEvent(event);
          await storeWhatsappRide(deps.redisClient, rideId, {
            riderId: user.id, phone, pickupAddress: pickupGeo.formattedAddress,
            destinationAddress: destGeo.formattedAddress, offerNgn: finalOffer, suggestedFareNgn, paymentMethod,
            createdAt: new Date().toISOString(),
          });
          await setActiveRide(deps.redisClient, user.id, rideId);

          const offerDisplay = `₦${finalOffer.toLocaleString()}`;
          const payLabel = paymentMethod === 'WALLET' ? 'Wallet (funds locked)' : 'Cash';
          const reply = `Looking for drivers from *${rideIntent.pickup.area}* to *${rideIntent.destination.area}*!\n\nOffer: ${offerDisplay}\nPayment: ${payLabel}\n\nI'll message you when drivers respond 🚗`;
          await appendWhatsappConversation(deps.redisClient, phone, [
            { role: 'user', content: incomingMessage },
            { role: 'assistant', content: reply },
          ]);
          await sendMetaReply(deps, phone, reply);
          return;
        }

        // No payment method mentioned — ask the user
        await storePendingPayment(deps.redisClient, user.id, {
          rideId, riderId: user.id, phone,
          pickupLat: pickupGeo.lat, pickupLng: pickupGeo.lng, pickupAddress: pickupGeo.formattedAddress, pickupArea: rideIntent.pickup.area,
          destLat: destGeo.lat, destLng: destGeo.lng, destAddress: destGeo.formattedAddress, destArea: rideIntent.destination.area,
          distanceKm: plannedRoute.distanceKm, durationSeconds: plannedRoute.durationSeconds,
          suggestedFareNgn, finalOffer, minOfferNgn: plannedRoute.minOfferNgn, ratePerKmNgn: plannedRoute.ratePerKmNgn,
          route: plannedRoute.geometry, createdAt: new Date().toISOString(),
        });

        const offerDisplay = `₦${finalOffer.toLocaleString()}`;
        const reply = `*${rideIntent.pickup.area}* → *${rideIntent.destination.area}*\nEstimated fare: ${offerDisplay}\n\nHow would you like to pay?\n\n*1.* Cash 💵\n*2.* Wallet 💰\n\nReply *cash* or *wallet*`;
        await appendWhatsappConversation(deps.redisClient, phone, [
          { role: 'user', content: incomingMessage },
          { role: 'assistant', content: reply },
        ]);
        await sendMetaReply(deps, phone, reply);
        return;
      }
      // Geocoding failed — fall through to AI conversation for clarification
    }

    // Ride request with vague locations — ask for specific streets
    if (rideIntent?.intent === 'ride_request' && rideIntent.pickup && rideIntent.destination
        && (!rideIntent.pickup.specific || !rideIntent.destination.specific)) {
      const vagueParts: string[] = [];
      if (!rideIntent.pickup.specific) vagueParts.push('pickup');
      if (!rideIntent.destination.specific) vagueParts.push('destination');

      let reply: string;
      if (vagueParts.length === 2) {
        reply = `I see you want to go from *${rideIntent.pickup.area}* to *${rideIntent.destination.area}*! Can you give me more specific locations?\n\nLike a street, bus stop, landmark, or plaza for both pickup and destination.\n\nExample: "From Shoprite ${rideIntent.pickup.area} to ${rideIntent.destination.area} BRT terminal"`;
      } else if (!rideIntent.pickup.specific) {
        reply = `Got it — heading to *${rideIntent.destination.address}*! Where exactly in *${rideIntent.pickup.area}* should the driver pick you up?\n\nA street name, bus stop, or landmark would help.`;
      } else {
        reply = `Picking up from *${rideIntent.pickup.address}*! Where exactly in *${rideIntent.destination.area}* are you going?\n\nA street name, bus stop, or landmark would help.`;
      }

      await appendWhatsappConversation(deps.redisClient, phone, [
        { role: 'user', content: incomingMessage },
        { role: 'assistant', content: reply },
      ]);
      await sendMetaReply(deps, phone, reply);
      return;
    }

    if (rideIntent?.intent === 'cancel_ride') {
      const activeRide = await getActiveRide(deps.redisClient, user.id);
      if (activeRide) {
        const cancelEvent = RideCancelledEvent.parse({
          eventType: 'RIDE_CANCELLED',
          rideId: activeRide,
          riderId: user.id,
          reason: 'rider_cancelled',
          timestamp: new Date().toISOString(),
        });
        await deps.publisher.publishRideEvent(cancelEvent);
        await clearActiveRide(deps.redisClient, user.id);
        await cleanupRideKeys(deps.redisClient, activeRide);

        const reply = 'Your ride has been cancelled. You can request another ride anytime!';
        await appendWhatsappConversation(deps.redisClient, phone, [
          { role: 'user', content: incomingMessage },
          { role: 'assistant', content: reply },
        ]);
        await sendMetaReply(deps, phone, reply);
        return;
      }
    }

    // AI response for all users
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
