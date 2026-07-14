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
} from '../whatsapp-flows/bid-state';
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
  // "wallet" means Naira wallet by default
  if (/\b(wallet|pay\s*wallet|wallet\s*payment|use\s*wallet|from\s*wallet)\b/.test(lower)) return 'WALLET';
  // Also match just "1" or "2" if they're replying to the choice
  if (/^1$/.test(lower)) return 'CASH';
  if (/^2$/.test(lower)) return 'WALLET';
  return null;
}

export interface TwilioWhatsappRouteDeps {
  jwtSecret: string;
  publisher: GatewayPublisher;
  pouchLiquifiaClient: PouchLiquifiaClient;
  redisClient: RedisClient;
  routePlanner: GoogleMapsRoutePlanner;
  googleMapsApiKey: string;
  twilioAccountSid?: string;
  twilioAuthToken?: string;
  twilioWhatsappNumber?: string;
  twilioKycContentSid?: string;
  groqApiKey?: string;
  groqModel: string;
  groqTimeoutMs: number;
  appBaseUrl?: string;
}

function getHeaderValue(req: IncomingMessage, name: string): string | null {
  const value = req.headers[name.toLowerCase()];
  return typeof value === 'string' ? value : null;
}

function getForwardedProto(req: IncomingMessage): string | null {
  const value = getHeaderValue(req, 'x-forwarded-proto');
  return value?.split(',')[0]?.trim() || null;
}

function getWebhookUrlCandidates(req: IncomingMessage): string[] {
  const host = getHeaderValue(req, 'x-forwarded-host') ?? getHeaderValue(req, 'host');
  if (!host) {
    return [];
  }

  const pathname = req.url ?? '/';
  const proto = getForwardedProto(req) ?? 'https';
  const protocols = proto === 'https' ? ['https', 'http'] : [proto, 'https'];
  return [...new Set(protocols)].map((protocol) => `${protocol}://${host}${pathname}`);
}

function buildTwilioSignatureBase(url: string, params: URLSearchParams): string {
  const pairs: Array<[string, string]> = [];
  for (const key of new Set(params.keys())) {
    for (const value of params.getAll(key)) {
      pairs.push([key, value]);
    }
  }

  pairs.sort(([leftKey, leftValue], [rightKey, rightValue]) => {
    const keyCompare = leftKey.localeCompare(rightKey);
    return keyCompare === 0 ? leftValue.localeCompare(rightValue) : keyCompare;
  });

  return pairs.reduce((base, [key, value]) => `${base}${key}${value}`, url);
}

function isEqualSignature(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, 'utf8');
  const rightBuffer = Buffer.from(right, 'utf8');
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function isValidTwilioSignature(
  req: IncomingMessage,
  params: URLSearchParams,
  authToken: string | undefined,
): boolean {
  if (!authToken) {
    return true;
  }

  const provided = getHeaderValue(req, 'x-twilio-signature');
  if (!provided) {
    return false;
  }

  return getWebhookUrlCandidates(req).some((url) => {
    const expected = createHmac('sha1', authToken)
      .update(buildTwilioSignatureBase(url, params))
      .digest('base64');

    return isEqualSignature(provided, expected);
  });
}

function normalizeWhatsappPhone(value: string | null): string | null {
  const normalized = value?.trim().replace(/^whatsapp:/i, '');
  if (!normalized || !/^\+[1-9]\d{6,14}$/.test(normalized)) {
    return null;
  }

  return normalized;
}

async function sendTwilioContentMessage(params: {
  accountSid: string;
  authToken: string;
  from: string;
  to: string;
  contentSid: string;
  contentVariables: Record<string, string>;
}): Promise<void> {
  const endpoint = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(params.accountSid)}/Messages.json`;
  const authHeader = Buffer.from(`${params.accountSid}:${params.authToken}`, 'utf8').toString('base64');
  const form = new URLSearchParams({
    To: params.to,
    From: params.from,
    ContentSid: params.contentSid,
    ContentVariables: JSON.stringify(params.contentVariables),
  });

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      authorization: `Basic ${authHeader}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: form.toString(),
  });

  if (!response.ok) {
    const payload = await response.text();
    console.error('[whatsapp] Content template send failed', { status: response.status, payload });
  }
}

function sendEmptyTwiml(res: ServerResponse): void {
  const body = '<?xml version="1.0" encoding="UTF-8"?><Response/>';
  res.statusCode = 200;
  res.setHeader('content-type', 'text/xml; charset=utf-8');
  res.setHeader('content-length', Buffer.byteLength(body));
  res.end(body);
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function sendTwiml(res: ServerResponse, message: string): void {
  const body = `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escapeXml(message)}</Message></Response>`;
  console.info('[whatsapp] Sending TwiML reply', { messageLength: message.length, reply: message.slice(0, 200) });
  res.statusCode = 200;
  res.setHeader('content-type', 'text/xml; charset=utf-8');
  res.setHeader('content-length', Buffer.byteLength(body));
  res.end(body);
}

export async function handleTwilioWhatsappWebhookRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: TwilioWhatsappRouteDeps,
): Promise<void> {
  try {
    const rawBody = await readRawBody(req);
    const params = new URLSearchParams(rawBody.toString('utf8'));

    if (!isValidTwilioSignature(req, params, deps.twilioAuthToken)) {
      sendJson(res, 403, { error: 'Invalid Twilio signature' });
      return;
    }

    const phone = normalizeWhatsappPhone(params.get('From'));
    if (!phone) {
      sendJson(res, 400, { error: 'Missing valid WhatsApp sender' });
      return;
    }

    const profileName = params.get('ProfileName') ?? undefined;
    const incomingMessage = params.get('Body')?.trim() ?? '';
    const user = await onboardWhatsappUser({
      phone,
      profileName,
      deps: {
        jwtSecret: deps.jwtSecret,
        publisher: deps.publisher,
        pouchLiquifiaClient: deps.pouchLiquifiaClient,
      },
    });

    // Send KYC button template once for brand-new users (non-blocking)
    if (user.created) {
      const freshUser = await userClient.findById(user.id);
      const isVerified = String(freshUser.riderKycStatus ?? 'NONE') === 'VERIFIED';
      const canSendButtonTemplate = Boolean(
        !isVerified &&
        deps.twilioAccountSid &&
        deps.twilioAuthToken &&
        deps.twilioWhatsappNumber &&
        deps.twilioKycContentSid &&
        deps.appBaseUrl,
      );

      if (canSendButtonTemplate) {
        const token = createLocalAccessToken(user.id, deps.jwtSecret);
        const kycPath = `widget/index.html?token=${token}&apiBase=${deps.appBaseUrl}`;
        const displayName = freshUser.name ?? profileName ?? phone;
        const first = displayName.trim().split(/\s+/)[0] ?? displayName;

        // Fire-and-forget — don't block the AI reply
        sendTwilioContentMessage({
          accountSid: deps.twilioAccountSid!,
          authToken: deps.twilioAuthToken!,
          from: `whatsapp:${deps.twilioWhatsappNumber}`,
          to: `whatsapp:${phone}`,
          contentSid: deps.twilioKycContentSid!,
          contentVariables: { '1': first, '2': kycPath },
        }).catch((err) => console.warn('[whatsapp] KYC button send failed', err));
      }
    }

    // Store phone lookup for Kafka consumer notifications
    await setPhoneLookup(deps.redisClient, user.id, phone).catch(() => {});

    const recentMessages = await getWhatsappConversation(deps.redisClient, phone);

    // Check if the user is replying to a payment method question
    const pendingPayment = await getPendingPayment(deps.redisClient, user.id);
    if (pendingPayment) {
      const paymentChoice = parsePaymentChoice(incomingMessage);
      if (paymentChoice) {
        await clearPendingPayment(deps.redisClient, user.id);

        if (paymentChoice === 'WALLET') {
          // Check wallet balance
          const wallet = await walletClient.findByUserId(user.id);
          if (!wallet || Number(wallet.balanceNgn) < pendingPayment.finalOffer) {
            const balance = wallet ? `₦${Number(wallet.balanceNgn).toLocaleString()}` : '₦0';
            const reply = `Your wallet balance is ${balance} but the ride costs ₦${pendingPayment.finalOffer.toLocaleString()}. Would you like to pay with *cash* instead?\n\nReply *cash* or *wallet* after topping up.`;
            await appendWhatsappConversation(deps.redisClient, phone, [
              { role: 'user', content: incomingMessage },
              { role: 'assistant', content: reply },
            ]);
            // Re-store the pending payment so they can try again
            await storePendingPayment(deps.redisClient, user.id, pendingPayment);
            sendTwiml(res, reply);
            return;
          }

          // Lock funds in wallet
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
            sendTwiml(res, reply);
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
        sendTwiml(res, reply);
        return;
      }
      // User didn't say cash/wallet — remind them
      const reply = `Please choose a payment method:\n\n*1.* Cash\n*2.* Wallet\n\nReply *cash* or *wallet*`;
      await appendWhatsappConversation(deps.redisClient, phone, [
        { role: 'user', content: incomingMessage },
        { role: 'assistant', content: reply },
      ]);
      sendTwiml(res, reply);
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
        sendTwiml(res, reply);
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
          // Normalize CRYPTO_WALLET to WALLET — both use the Naira wallet for ride payments
          const paymentMethod: 'CASH' | 'WALLET' = rideIntent.paymentMethod === 'CASH' ? 'CASH' : 'WALLET';

          if (paymentMethod === 'WALLET') {
            const wallet = await walletClient.findByUserId(user.id);
            if (!wallet || Number(wallet.balanceNgn) < finalOffer) {
              const balance = wallet ? `₦${Number(wallet.balanceNgn).toLocaleString()}` : '₦0';
              // Store pending so they can switch to cash
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
              sendTwiml(res, reply);
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
              sendTwiml(res, reply);
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
          sendTwiml(res, reply);
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
        sendTwiml(res, reply);
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
      sendTwiml(res, reply);
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
        sendTwiml(res, reply);
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

    sendTwiml(res, reply);
  } catch (error) {
    console.error('[whatsapp] webhook handling failed', error);
    sendTwiml(
      res,
      'Sorry, Wheelers could not process your message right now. Please try again shortly.',
    );
  }
}
