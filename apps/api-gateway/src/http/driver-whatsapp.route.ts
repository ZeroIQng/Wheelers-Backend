import { createHmac, timingSafeEqual } from 'crypto';
import type { IncomingMessage, ServerResponse } from 'http';
import { driverClient, userClient, UserRole } from '@wheleers/db';
import { DriverOnlineEvent, DriverOfflineEvent, RideCounterOfferEvent } from '@wheleers/kafka-schemas';
import type { GatewayPublisher } from '../websocket/publisher';
import { onboardWhatsappUser } from '../onboarding/user-onboarding';
import type { PouchLiquifiaClient } from '@wheleers/pouch-client';
import {
  appendWhatsappConversation,
  getWhatsappConversation,
} from '../LLM/conversation-store';
import { GroqClient } from '../LLM/groq.client';
import { parseDriverIntent } from '../LLM/driver-intent-parser';
import {
  storeDriverProfile,
  getDriverProfile,
  clearDriverProfile,
  getDriverOffers,
  removeDriverOffer,
  setDriverPhoneLookup,
} from '../whatsapp-flows/driver-state';
import type { RedisClient } from '../redis/client';
import { readRawBody, sendJson } from './utils';

export interface DriverWhatsappRouteDeps {
  jwtSecret: string;
  publisher: GatewayPublisher;
  pouchLiquifiaClient: PouchLiquifiaClient;
  redisClient: RedisClient;
  twilioAccountSid?: string;
  twilioAuthToken?: string;
  twilioDriverWhatsappNumber?: string;
  groqApiKey?: string;
  groqModel: string;
  groqTimeoutMs: number;
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
  if (!host) return [];
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
  pairs.sort(([lk, lv], [rk, rv]) => {
    const c = lk.localeCompare(rk);
    return c === 0 ? lv.localeCompare(rv) : c;
  });
  return pairs.reduce((base, [key, value]) => `${base}${key}${value}`, url);
}

function isValidTwilioSignature(
  req: IncomingMessage,
  params: URLSearchParams,
  authToken: string | undefined,
): boolean {
  if (!authToken) return true;
  const provided = getHeaderValue(req, 'x-twilio-signature');
  if (!provided) return false;

  return getWebhookUrlCandidates(req).some((url) => {
    const expected = createHmac('sha1', authToken)
      .update(buildTwilioSignatureBase(url, params))
      .digest('base64');
    const leftBuf = Buffer.from(provided, 'utf8');
    const rightBuf = Buffer.from(expected, 'utf8');
    return leftBuf.length === rightBuf.length && timingSafeEqual(leftBuf, rightBuf);
  });
}

function normalizeWhatsappPhone(value: string | null): string | null {
  const normalized = value?.trim().replace(/^whatsapp:/i, '');
  if (!normalized || !/^\+[1-9]\d{6,14}$/.test(normalized)) return null;
  return normalized;
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
  res.statusCode = 200;
  res.setHeader('content-type', 'text/xml; charset=utf-8');
  res.setHeader('content-length', Buffer.byteLength(body));
  res.end(body);
}

export async function handleDriverWhatsappWebhookRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: DriverWhatsappRouteDeps,
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

    // Onboard user (creates User record if new)
    const user = await onboardWhatsappUser({
      phone,
      profileName,
      deps: {
        jwtSecret: deps.jwtSecret,
        publisher: deps.publisher,
        pouchLiquifiaClient: deps.pouchLiquifiaClient,
      },
    });

    // Ensure user has DRIVER or BOTH role and a Driver record
    let driver = await driverClient.findByUserId(user.id).catch(() => null);
    if (!driver) {
      // Create driver record and upgrade role
      const currentUser = await userClient.findById(user.id);
      const newRole = currentUser.role === 'RIDER' ? UserRole.BOTH : currentUser.role;
      if (newRole !== currentUser.role) {
        await userClient.updateRole(user.id, newRole);
      }
      await driverClient.create(user.id);
      driver = await driverClient.findByUserId(user.id);
    }

    if (!driver) {
      sendTwiml(res, 'Unable to set up your driver account. Please try again.');
      return;
    }

    // Store phone lookup for notifications
    await setDriverPhoneLookup(deps.redisClient, user.id, phone).catch(() => {});

    const recentMessages = await getWhatsappConversation(deps.redisClient, `driver:${phone}`);
    const groq = new GroqClient({
      apiKey: deps.groqApiKey,
      model: deps.groqModel,
      timeoutMs: deps.groqTimeoutMs,
    });

    const intent = await parseDriverIntent(groq, incomingMessage, recentMessages);

    // Handle go online
    if (intent?.intent === 'go_online') {
      // Check if driver has a location from WhatsApp (Latitude/Longitude params)
      const lat = parseFloat(params.get('Latitude') ?? '');
      const lng = parseFloat(params.get('Longitude') ?? '');

      if (isNaN(lat) || isNaN(lng)) {
        const reply = 'To go online, please share your location first! Tap the attachment icon (📎) → Location → Send your current location.';
        await appendWhatsappConversation(deps.redisClient, `driver:${phone}`, [
          { role: 'user', content: incomingMessage },
          { role: 'assistant', content: reply },
        ]);
        sendTwiml(res, reply);
        return;
      }

      const event = DriverOnlineEvent.parse({
        eventType: 'DRIVER_ONLINE',
        driverId: driver.id,
        userId: user.id,
        lat,
        lng,
        vehiclePlate: driver.vehiclePlate ?? 'UNKNOWN',
        vehicleModel: driver.vehicleModel ?? 'UNKNOWN',
        timestamp: new Date().toISOString(),
      });

      await deps.publisher.publishDriverEvent(event);

      await storeDriverProfile(deps.redisClient, {
        userId: user.id,
        driverId: driver.id,
        phone,
        name: user.name ?? profileName ?? 'Driver',
        rating: driver.rating ?? 5.0,
        vehiclePlate: driver.vehiclePlate ?? 'UNKNOWN',
        vehicleModel: driver.vehicleModel ?? 'UNKNOWN',
        lat,
        lng,
        onlineSince: new Date().toISOString(),
      });

      const reply = `You're now online! I'll send you ride requests nearby. Say "go offline" when you're done for the day.`;
      await appendWhatsappConversation(deps.redisClient, `driver:${phone}`, [
        { role: 'user', content: incomingMessage },
        { role: 'assistant', content: reply },
      ]);
      sendTwiml(res, reply);
      return;
    }

    // Handle go offline
    if (intent?.intent === 'go_offline') {
      const profile = await getDriverProfile(deps.redisClient, user.id);
      if (profile) {
        const event = DriverOfflineEvent.parse({
          eventType: 'DRIVER_OFFLINE',
          driverId: profile.driverId,
          reason: 'manual',
          timestamp: new Date().toISOString(),
        });
        await deps.publisher.publishDriverEvent(event);
        await clearDriverProfile(deps.redisClient, user.id);
      }

      const reply = "You're now offline. No more ride requests. Say \"go online\" when you're ready again!";
      await appendWhatsappConversation(deps.redisClient, `driver:${phone}`, [
        { role: 'user', content: incomingMessage },
        { role: 'assistant', content: reply },
      ]);
      sendTwiml(res, reply);
      return;
    }

    // Handle bid on a ride
    if (intent?.intent === 'bid') {
      const profile = await getDriverProfile(deps.redisClient, user.id);
      if (!profile) {
        const reply = "You need to be online first! Share your location and say \"go online\".";
        await appendWhatsappConversation(deps.redisClient, `driver:${phone}`, [
          { role: 'user', content: incomingMessage },
          { role: 'assistant', content: reply },
        ]);
        sendTwiml(res, reply);
        return;
      }

      const offers = await getDriverOffers(deps.redisClient, user.id);
      if (offers.length === 0) {
        const reply = 'No active ride requests right now. Stay online and I\'ll notify you when a ride comes in!';
        await appendWhatsappConversation(deps.redisClient, `driver:${phone}`, [
          { role: 'user', content: incomingMessage },
          { role: 'assistant', content: reply },
        ]);
        sendTwiml(res, reply);
        return;
      }

      const rideIndex = intent.bidRideIndex ?? 0;
      const offer = offers[rideIndex] ?? offers[0];
      const bidAmount = intent.bidAmountNgn ?? offer.riderOfferNgn;

      if (bidAmount < 100 || bidAmount > 1_000_000) {
        const reply = 'Please enter a bid between ₦100 and ₦1,000,000.';
        await appendWhatsappConversation(deps.redisClient, `driver:${phone}`, [
          { role: 'user', content: incomingMessage },
          { role: 'assistant', content: reply },
        ]);
        sendTwiml(res, reply);
        return;
      }

      const driverRecord = await driverClient.findByUserId(user.id).catch(() => null);

      const event = RideCounterOfferEvent.parse({
        eventType: 'RIDE_COUNTER_OFFER',
        rideId: offer.rideId,
        riderId: offer.riderId,
        driverId: profile.driverId,
        driverUserId: user.id,
        counterOfferNgn: bidAmount,
        driverName: profile.name,
        driverRating: driverRecord?.rating ?? profile.rating,
        vehiclePlate: driverRecord?.vehiclePlate ?? profile.vehiclePlate,
        vehicleModel: driverRecord?.vehicleModel ?? profile.vehicleModel,
        etaSeconds: 0,
        timestamp: new Date().toISOString(),
      });

      await deps.publisher.publishRideEvent(event);
      await removeDriverOffer(deps.redisClient, user.id, offer.rideId);

      const priceDisplay = `₦${bidAmount.toLocaleString()}`;
      const reply = bidAmount === offer.riderOfferNgn
        ? `Accepted! Your bid of ${priceDisplay} for ${offer.pickupAddress} → ${offer.destinationAddress} has been sent. Waiting for rider to confirm...`
        : `Your counter-offer of ${priceDisplay} for ${offer.pickupAddress} → ${offer.destinationAddress} has been sent. Waiting for rider...`;
      await appendWhatsappConversation(deps.redisClient, `driver:${phone}`, [
        { role: 'user', content: incomingMessage },
        { role: 'assistant', content: reply },
      ]);
      sendTwiml(res, reply);
      return;
    }

    // Handle check earnings
    if (intent?.intent === 'check_earnings') {
      const driverRecord = await driverClient.findByUserId(user.id).catch(() => null);
      const earnings = driverRecord?.totalEarningsNgn ?? 0;
      const totalRides = driverRecord?.totalRides ?? 0;
      const rating = driverRecord?.rating ?? 5.0;

      const reply = `Your stats:\n💰 Total earnings: ₦${earnings.toLocaleString()}\n🚗 Total rides: ${totalRides}\n⭐ Rating: ${rating.toFixed(1)}`;
      await appendWhatsappConversation(deps.redisClient, `driver:${phone}`, [
        { role: 'user', content: incomingMessage },
        { role: 'assistant', content: reply },
      ]);
      sendTwiml(res, reply);
      return;
    }

    // Default: AI conversation
    const reply = user.created
      ? `Welcome to Wheelers Driver! I'm your driving assistant.\n\nTo start receiving rides:\n1. Share your location (📎 → Location)\n2. Say "go online"\n\nI'll send you ride requests from nearby riders. You can bid, accept, or reject them right here on WhatsApp!`
      : `Hey! I'm your Wheelers driver assistant. Here's what you can do:\n• "go online" — start receiving rides\n• "go offline" — stop receiving rides\n• "bid [amount]" — bid on a ride\n• "accept" — accept at rider's price\n• "earnings" — check your stats\n\nNeed anything else? Just ask!`;

    await appendWhatsappConversation(deps.redisClient, `driver:${phone}`, [
      { role: 'user', content: incomingMessage || '[empty message]' },
      { role: 'assistant', content: reply },
    ]);

    sendTwiml(res, reply);
  } catch (error) {
    console.error('[driver-whatsapp] webhook handling failed', error);
    sendTwiml(
      res,
      'Sorry, something went wrong. Please try again shortly.',
    );
  }
}
