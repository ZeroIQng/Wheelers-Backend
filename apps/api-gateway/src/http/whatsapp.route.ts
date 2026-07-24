import { createHmac, randomUUID, timingSafeEqual } from 'crypto';
import type { IncomingMessage, ServerResponse } from 'http';
import { driverClient, walletClient, virtualAccountClient } from '@wheleers/db';
import { GoogleMapsRoutePlanner, calculateRideFees } from '@wheleers/config';
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
  storePendingRoute,
  getPendingRoute,
  clearPendingRoute,
  storePendingAccept,
  getPendingAccept,
  clearPendingAccept,
} from '../whatsapp-flows/bid-state';
import type { WhatsappBid } from '../whatsapp-flows/bid-state';
import {
  formatBidList,
} from '../whatsapp-flows/whatsapp-notifier';
import type { DriverKycStorage } from '../storage/driver-kyc-storage';
import type { RedisClient } from '../redis/client';
import { readRawBody, sendJson } from './utils';

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
  driverKycStorage?: DriverKycStorage;
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

async function sendMetaImageMessage(
  deps: MetaWhatsappRouteDeps,
  to: string,
  imageUrl: string,
  caption?: string,
): Promise<void> {
  if (!deps.metaAccessToken || !deps.metaPhoneNumberId) return;

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
      type: 'image',
      image: { link: imageUrl, ...(caption ? { caption } : {}) },
    }),
  });

  if (!response.ok) {
    const payload = await response.text();
    console.error('[whatsapp] Meta image send failed', { status: response.status, payload });
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
  messageId: string;
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
      const msgId = msg.id as string | undefined;
      const from = msg.from as string | undefined;
      const phone = normalizeMetaPhone(from);
      if (!phone) continue;

      // Get profile name from contacts array
      const contacts = value.contacts as Array<Record<string, unknown>> | undefined;
      const profileName = contacts?.[0]?.profile
        ? (contacts[0].profile as Record<string, unknown>).name as string | undefined
        : undefined;

      const wamid = msgId ?? '';

      // Handle location messages
      if (msg.type === 'location') {
        const location = msg.location as Record<string, unknown> | undefined;
        const lat = Number(location?.latitude);
        const lng = Number(location?.longitude);
        return {
          messageId: wamid,
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
          messageId: wamid,
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
            messageId: wamid,
            phone,
            profileName,
            messageBody: (buttonReply?.title as string) ?? '',
            isLocation: false,
          };
        }
        if (interactive?.type === 'list_reply') {
          const listReply = interactive.list_reply as Record<string, unknown>;
          return {
            messageId: wamid,
            phone,
            profileName,
            messageBody: (listReply?.title as string) ?? '',
            isLocation: false,
          };
        }
      }

      // Default: treat as empty
      return { messageId: wamid, phone, profileName, messageBody: '', isLocation: false };
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
  // Match natural language with a number: "I rebid 1300", "counter offer to 1400", "my offer is ₦1200"
  const nlNum = lower.match(/(?:bid|offer|counter|price|pay)\b.*?[₦n]?\s*(\d{3,6})\b/);
  if (nlNum) return parseInt(nlNum[1], 10);
  // Match natural language with "k" shorthand: "I'll do 1.5k", "offer 2k"
  const nlK = lower.match(/(?:bid|offer|counter|price|pay)\b.*?(\d+(?:\.\d+)?)\s*k\b/);
  if (nlK) return Math.round(parseFloat(nlK[1]) * 1000);
  // Last resort: message with a number + negotiation keyword (e.g. "how about 1300", "I'll do 1.5k")
  const hasNegotiationWord = /\b(bid|offer|counter|price|pay|how\s*about|what\s*about|do|make\s*it|set|change)\b/.test(lower);
  if (hasNegotiationWord) {
    const anyK = lower.match(/\b(\d+(?:\.\d+)?)\s*k\b/);
    if (anyK) return Math.round(parseFloat(anyK[1]) * 1000);
    const anyNum = lower.match(/\b(\d{3,6})\b/);
    if (anyNum) return parseInt(anyNum[1], 10);
  }
  return null;
}

function isMoreCommand(message: string): boolean {
  return /^(more|more\s+drivers|refresh|next)$/i.test(message.trim());
}

function isCancelCommand(message: string): boolean {
  const m = message.trim().toLowerCase();
  if (/^cancel$/i.test(m)) return true;
  return /\b(cancel|stop|end)\b.*\b(ride|trip|booking)\b/i.test(m)
    || /\b(ride|trip|booking)\b.*\b(cancel|stop|end)\b/i.test(m);
}

function isEditPickupCommand(message: string): boolean {
  const m = message.trim().toLowerCase();
  return /\b(edit|change|update|modify)\b.*\b(pickup|pick\s*up|pick\s*-\s*up|origin|start|from)\b/i.test(m)
    || /\b(pickup|pick\s*up|pick\s*-\s*up|from)\b.*\b(edit|change|update|modify)\b/i.test(m)
    || /^edit\s*(pickup|from)$/i.test(m);
}

function isEditDestinationCommand(message: string): boolean {
  const m = message.trim().toLowerCase();
  return /\b(edit|change|update|modify)\b.*\b(destination|dest|drop\s*off|dropoff|drop\s*-\s*off|where|to)\b/i.test(m)
    || /\b(destination|dest|drop\s*off|dropoff|drop\s*-\s*off|to)\b.*\b(edit|change|update|modify)\b/i.test(m)
    || /^edit\s*(destination|to)$/i.test(m);
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

    // ── Dedup: Meta retries webhooks — skip if we already processed this message ──
    if (msgInfo.messageId) {
      const dedupKey = `whatsapp:dedup:${msgInfo.messageId}`;
      const alreadyProcessed = await deps.redisClient.get(dedupKey).catch(() => null);
      if (alreadyProcessed) return;
      await deps.redisClient.set(dedupKey, '1', 300).catch(() => {});
    }

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

      // ── Confirm — user is confirming after seeing driver details ──
      const pendingAccept = await getPendingAccept(deps.redisClient, user.id);
      if (pendingAccept && /^(yes|confirm|accept|go|proceed)$/i.test(incomingMessage.trim())) {
        // Rider already paid at booking — adjust hold if driver's bid is higher
        const agreedFare = pendingAccept.fareNgn;

        try {
          await walletClient.adjustRideHold({
            rideId: pendingAccept.rideId,
            targetAmountNgn: agreedFare,
          });
        } catch {
          const wallet = await walletClient.findByUserId(user.id);
          const balance = wallet ? Number(wallet.balanceNgn) : 0;
          const reply = `This driver's price is ₦${agreedFare.toLocaleString()} but your wallet doesn't have enough to cover the difference.\n\nWallet balance: ₦${balance.toLocaleString()}\n\nTop up and reply *confirm*, or reply *cancel* to cancel.`;
          await appendWhatsappConversation(deps.redisClient, phone, [
            { role: 'user', content: incomingMessage },
            { role: 'assistant', content: reply },
          ]);
          await sendMetaReply(deps, phone, reply);
          return;
        }

        // Confirm the ride
        await clearPendingAccept(deps.redisClient, user.id);

        const acceptEvent = RideOfferAcceptedEvent.parse({
          eventType: 'RIDE_OFFER_ACCEPTED',
          rideId: pendingAccept.rideId,
          riderId: user.id,
          driverId: pendingAccept.driverId,
          driverUserId: pendingAccept.driverUserId,
          agreedFareNgn: agreedFare,
          paymentMethod: 'WALLET',
          timestamp: new Date().toISOString(),
        });
        await deps.publisher.publishRideEvent(acceptEvent);
        await setRideState(deps.redisClient, pendingAccept.rideId, 'confirmed');

        await storeAcceptedBid(deps.redisClient, pendingAccept.rideId, {
          driverName: pendingAccept.driverName,
          driverPhone: pendingAccept.driverPhone,
          driverUserId: pendingAccept.driverUserId,
          vehicleModel: pendingAccept.vehicleModel,
          vehiclePlate: pendingAccept.vehiclePlate,
          vehicleColor: '',
          driverRating: pendingAccept.driverRating,
          totalRides: pendingAccept.totalRides,
          etaSeconds: pendingAccept.etaSeconds,
          fareNgn: agreedFare,
        });

        const etaMin = Math.ceil(pendingAccept.etaSeconds / 60);
        const reply = [
          `✅ *Ride confirmed!*`,
          ``,
          `Driver: *${pendingAccept.driverName}*`,
          `Vehicle: ${pendingAccept.vehicleModel} (${pendingAccept.vehiclePlate})`,
          `Rating: ${pendingAccept.driverRating.toFixed(1)}★`,
          `ETA: ${etaMin} min`,
          `Fare: ₦${agreedFare.toLocaleString()}`,
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

      // If pending accept but user said something else, remind them
      if (pendingAccept) {
        const reply = `Reply *confirm* to accept ${pendingAccept.driverName} at ₦${pendingAccept.fareNgn.toLocaleString()}, or reply *cancel* to cancel.`;
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

        // Fetch driver details + KYC images
        let driverPhone = '';
        let totalRides = 0;
        try {
          const driver = await driverClient.findById(selectedBid.driverId);
          driverPhone = driver.user.phone ?? '';
          totalRides = driver.totalRides ?? 0;
        } catch {
          // Non-critical
        }

        // Send driver selfie + vehicle photo if available
        if (deps.driverKycStorage) {
          try {
            const kyc = await driverClient.findKycSubmission(selectedBid.driverId);
            if (kyc) {
              const imagePromises: Promise<void>[] = [];
              if (kyc.selfieKey) {
                const selfieUrl = await deps.driverKycStorage.getSignedUrl(kyc.selfieKey);
                imagePromises.push(sendMetaImageMessage(deps, phone, selfieUrl, `${selectedBid.driverName}`));
              }
              if (kyc.vehicleImageKeys?.length) {
                const vehicleUrl = await deps.driverKycStorage.getSignedUrl(kyc.vehicleImageKeys[0]);
                imagePromises.push(sendMetaImageMessage(deps, phone, vehicleUrl, `${selectedBid.vehicleModel} (${selectedBid.vehiclePlate})`));
              }
              await Promise.all(imagePromises);
            }
          } catch {
            // Non-critical — driver details message still goes out
          }
        }

        // Store pending accept — don't confirm yet, show details and ask to pay
        await storePendingAccept(deps.redisClient, user.id, {
          rideId: activeRideId,
          driverId: selectedBid.driverId,
          driverUserId: selectedBid.driverUserId,
          driverName: selectedBid.driverName,
          driverPhone,
          driverRating: selectedBid.driverRating,
          totalRides,
          vehicleModel: selectedBid.vehicleModel,
          vehiclePlate: selectedBid.vehiclePlate,
          etaSeconds: selectedBid.etaSeconds,
          fareNgn: selectedBid.counterOfferNgn,
        });

        const etaMin = Math.ceil(selectedBid.etaSeconds / 60);
        const wallet = await walletClient.findByUserId(user.id);
        const balance = wallet ? Number(wallet.balanceNgn) : 0;
        const bidFees = calculateRideFees(selectedBid.counterOfferNgn);

        const reply = [
          `🚗 *Driver Details*`,
          ``,
          `Driver: *${selectedBid.driverName}*`,
          `Vehicle: ${selectedBid.vehicleModel} (${selectedBid.vehiclePlate})`,
          `Rating: ${selectedBid.driverRating.toFixed(1)}★ · ${totalRides} rides`,
          `ETA: ${etaMin} min`,
          `Fare: ₦${bidFees.totalNgn.toLocaleString()}`,
          ``,
          `Wallet balance: ₦${balance.toLocaleString()}`,
          ``,
          balance >= bidFees.totalNgn
            ? `Reply *pay* to confirm and pay ₦${bidFees.totalNgn.toLocaleString()} from your wallet`
            : `You need ₦${(bidFees.totalNgn - balance).toLocaleString()} more. Top up your wallet and reply *pay*`,
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

      // ── Editing pickup/destination via location pin ──
      if (bookingStage === 'editing_pickup' || bookingStage === 'editing_destination') {
        const pendingRoute = await getPendingRoute(deps.redisClient, user.id);
        if (pendingRoute) {
          const pickup = bookingStage === 'editing_pickup'
            ? { lat: locationLat, lng: locationLng, address }
            : { lat: pendingRoute.pickupLat, lng: pendingRoute.pickupLng, address: pendingRoute.pickupAddress };
          const destination = bookingStage === 'editing_destination'
            ? { lat: locationLat, lng: locationLng, address }
            : { lat: pendingRoute.destLat, lng: pendingRoute.destLng, address: pendingRoute.destAddress };

          const plannedRoute = await deps.routePlanner.planRoute({ origin: pickup, destination });
          const distanceKm = plannedRoute.distanceKm;
          const durationMin = Math.ceil(plannedRoute.durationSeconds / 60);
          const suggestedFare = plannedRoute.suggestedFareNgn;
          const minFare = plannedRoute.minOfferNgn;

          await storePendingRoute(deps.redisClient, user.id, {
            pickupLat: pickup.lat,
            pickupLng: pickup.lng,
            pickupAddress: pickup.address,
            destLat: destination.lat,
            destLng: destination.lng,
            destAddress: destination.address,
            distanceKm,
            durationSeconds: plannedRoute.durationSeconds,
            suggestedFareNgn: suggestedFare,
            minOfferNgn: minFare,
            ratePerKmNgn: plannedRoute.ratePerKmNgn,
            route: plannedRoute.geometry,
          });
          await setBookingStage(deps.redisClient, user.id, 'awaiting_price');

          const editedLabel = bookingStage === 'editing_pickup' ? 'Pickup updated!' : 'Destination updated!';
          const reply = [
            `✅ *${editedLabel}*`,
            ``,
            `Pickup: *${pickup.address}*`,
            ``,
            `Destination: *${destination.address}*`,
            ``,
            `${distanceKm.toFixed(1)} km · ~${durationMin} min`,
            `Minimum fare: ₦${minFare.toLocaleString()}`,
            `Suggested fare: ₦${suggestedFare.toLocaleString()}`,
            ``,
            `Send your offer (e.g. *${suggestedFare.toLocaleString()}* or *${Math.round(suggestedFare * 0.85).toLocaleString()}*)`,
          ].join('\n');

          await appendWhatsappConversation(deps.redisClient, phone, [
            { role: 'user', content: `[Shared location: ${address}]` },
            { role: 'assistant', content: reply },
          ]);
          await sendMetaReply(deps, phone, reply);
          return;
        }
      }

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
      // We have pickup, now got destination — go straight to finding drivers
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

      // Plan route, store it, and ask rider for their price
      const plannedRoute = await deps.routePlanner.planRoute({ origin: pickup, destination });
      const distanceKm = plannedRoute.distanceKm;
      const durationMin = Math.ceil(plannedRoute.durationSeconds / 60);
      const suggestedFare = plannedRoute.suggestedFareNgn;
      const minFare = plannedRoute.minOfferNgn;

      await storePendingRoute(deps.redisClient, user.id, {
        pickupLat: pickup.lat,
        pickupLng: pickup.lng,
        pickupAddress: pickup.address,
        destLat: destination.lat,
        destLng: destination.lng,
        destAddress: destination.address,
        distanceKm,
        durationSeconds: plannedRoute.durationSeconds,
        suggestedFareNgn: suggestedFare,
        minOfferNgn: minFare,
        ratePerKmNgn: plannedRoute.ratePerKmNgn,
        route: plannedRoute.geometry,
      });
      await setBookingStage(deps.redisClient, user.id, 'awaiting_price');

      const reply = [
        `Pickup: *${pickup.address}*`,
        ``,
        `Destination: *${destination.address}*`,
        ``,
        `${distanceKm.toFixed(1)} km · ~${durationMin} min`,
        `Minimum fare: ₦${minFare.toLocaleString()}`,
        `Suggested fare: ₦${suggestedFare.toLocaleString()}`,
        ``,
        `Negotiate your price and we'll find you a driver!`,
        `Send your offer (e.g. *${suggestedFare.toLocaleString()}* or *${Math.round(suggestedFare * 0.85).toLocaleString()}*)`,
      ].join('\n');

      await appendWhatsappConversation(deps.redisClient, phone, [
        { role: 'user', content: `[Shared destination location: ${address}]` },
        { role: 'assistant', content: reply },
      ]);
      await sendMetaReply(deps, phone, reply);
      return;
    }

    // ══════════════════════════════════════════════════════════════════════
    // 3. AWAITING DESTINATION — user can type an address or share a pin
    // ══════════════════════════════════════════════════════════════════════

    if (bookingStage === 'awaiting_destination' && !isLocation) {
      const pendingPickup = await getPendingLocation(deps.redisClient, user.id);
      if (!pendingPickup) {
        await clearBookingStage(deps.redisClient, user.id);
        const reply = 'Session expired. Type your pickup and destination like:\n\n*"From [pickup] to [destination]"*\n\nOr share a location pin 📍';
        await appendWhatsappConversation(deps.redisClient, phone, [
          { role: 'user', content: incomingMessage },
          { role: 'assistant', content: reply },
        ]);
        await sendMetaReply(deps, phone, reply);
        return;
      }

      // Try to geocode the typed destination
      const destGeo = await geocodeAddress(deps.googleMapsApiKey, incomingMessage.trim());
      if (!destGeo) {
        const reply = `Could not find "${incomingMessage.trim()}" on the map.\n\nPlease type a more specific destination address or share a location pin 📍`;
        await appendWhatsappConversation(deps.redisClient, phone, [
          { role: 'user', content: incomingMessage },
          { role: 'assistant', content: reply },
        ]);
        await sendMetaReply(deps, phone, reply);
        return;
      }

      // Destination geocoded — plan route
      const pickup = { lat: pendingPickup.lat, lng: pendingPickup.lng, address: pendingPickup.address };
      const destination = { lat: destGeo.lat, lng: destGeo.lng, address: destGeo.formattedAddress };

      await clearPendingLocation(deps.redisClient, user.id);
      await clearBookingStage(deps.redisClient, user.id);

      const plannedRoute = await deps.routePlanner.planRoute({ origin: pickup, destination });
      const distanceKm = plannedRoute.distanceKm;
      const durationMin = Math.ceil(plannedRoute.durationSeconds / 60);
      const suggestedFare = plannedRoute.suggestedFareNgn;
      const minFare = plannedRoute.minOfferNgn;

      await storePendingRoute(deps.redisClient, user.id, {
        pickupLat: pickup.lat,
        pickupLng: pickup.lng,
        pickupAddress: pickup.address,
        destLat: destination.lat,
        destLng: destination.lng,
        destAddress: destination.address,
        distanceKm,
        durationSeconds: plannedRoute.durationSeconds,
        suggestedFareNgn: suggestedFare,
        minOfferNgn: minFare,
        ratePerKmNgn: plannedRoute.ratePerKmNgn,
        route: plannedRoute.geometry,
      });
      await setBookingStage(deps.redisClient, user.id, 'awaiting_price');

      const reply = [
        `Pickup: *${pickup.address}*`,
        ``,
        `Destination: *${destination.address}*`,
        ``,
        `${distanceKm.toFixed(1)} km · ~${durationMin} min`,
        `Minimum fare: ₦${minFare.toLocaleString()}`,
        `Suggested fare: ₦${suggestedFare.toLocaleString()}`,
        ``,
        `Negotiate your price and we'll find you a driver!`,
        `Send your offer (e.g. *${suggestedFare.toLocaleString()}* or *${Math.round(suggestedFare * 0.85).toLocaleString()}*)`,
      ].join('\n');

      await appendWhatsappConversation(deps.redisClient, phone, [
        { role: 'user', content: incomingMessage },
        { role: 'assistant', content: reply },
      ]);
      await sendMetaReply(deps, phone, reply);
      return;
    }

    // ══════════════════════════════════════════════════════════════════════
    // 3b. EDITING PICKUP / DESTINATION — user types an address
    // ══════════════════════════════════════════════════════════════════════

    if ((bookingStage === 'editing_pickup' || bookingStage === 'editing_destination') && !isLocation) {
      const pendingRoute = await getPendingRoute(deps.redisClient, user.id);
      if (!pendingRoute) {
        await clearBookingStage(deps.redisClient, user.id);
        const reply = 'Session expired. Share a location pin to start a new booking 📍';
        await appendWhatsappConversation(deps.redisClient, phone, [
          { role: 'user', content: incomingMessage },
          { role: 'assistant', content: reply },
        ]);
        await sendMetaReply(deps, phone, reply);
        return;
      }

      const geo = await geocodeAddress(deps.googleMapsApiKey, incomingMessage.trim());
      if (!geo) {
        const label = bookingStage === 'editing_pickup' ? 'pickup' : 'destination';
        const reply = `Could not find "${incomingMessage.trim()}" on the map.\n\nPlease type a more specific ${label} address or share a location pin 📍`;
        await appendWhatsappConversation(deps.redisClient, phone, [
          { role: 'user', content: incomingMessage },
          { role: 'assistant', content: reply },
        ]);
        await sendMetaReply(deps, phone, reply);
        return;
      }

      const pickup = bookingStage === 'editing_pickup'
        ? { lat: geo.lat, lng: geo.lng, address: geo.formattedAddress }
        : { lat: pendingRoute.pickupLat, lng: pendingRoute.pickupLng, address: pendingRoute.pickupAddress };
      const destination = bookingStage === 'editing_destination'
        ? { lat: geo.lat, lng: geo.lng, address: geo.formattedAddress }
        : { lat: pendingRoute.destLat, lng: pendingRoute.destLng, address: pendingRoute.destAddress };

      const plannedRoute = await deps.routePlanner.planRoute({ origin: pickup, destination });
      const distanceKm = plannedRoute.distanceKm;
      const durationMin = Math.ceil(plannedRoute.durationSeconds / 60);
      const suggestedFare = plannedRoute.suggestedFareNgn;
      const minFare = plannedRoute.minOfferNgn;

      await storePendingRoute(deps.redisClient, user.id, {
        pickupLat: pickup.lat,
        pickupLng: pickup.lng,
        pickupAddress: pickup.address,
        destLat: destination.lat,
        destLng: destination.lng,
        destAddress: destination.address,
        distanceKm,
        durationSeconds: plannedRoute.durationSeconds,
        suggestedFareNgn: suggestedFare,
        minOfferNgn: minFare,
        ratePerKmNgn: plannedRoute.ratePerKmNgn,
        route: plannedRoute.geometry,
      });
      await setBookingStage(deps.redisClient, user.id, 'awaiting_price');

      const editedLabel = bookingStage === 'editing_pickup' ? 'Pickup updated!' : 'Destination updated!';
      const reply = [
        `✅ *${editedLabel}*`,
        ``,
        `Pickup: *${pickup.address}*`,
        ``,
        `Destination: *${destination.address}*`,
        ``,
        `${distanceKm.toFixed(1)} km · ~${durationMin} min`,
        `Minimum fare: ₦${minFare.toLocaleString()}`,
        `Suggested fare: ₦${suggestedFare.toLocaleString()}`,
        ``,
        `Send your offer (e.g. *${suggestedFare.toLocaleString()}* or *${Math.round(suggestedFare * 0.85).toLocaleString()}*)`,
      ].join('\n');

      await appendWhatsappConversation(deps.redisClient, phone, [
        { role: 'user', content: incomingMessage },
        { role: 'assistant', content: reply },
      ]);
      await sendMetaReply(deps, phone, reply);
      return;
    }

    // ══════════════════════════════════════════════════════════════════════
    // 4. AWAITING PRICE — user sends their offer after seeing route info
    // ══════════════════════════════════════════════════════════════════════

    if (bookingStage === 'awaiting_price' && !isLocation) {
      const pendingRoute = await getPendingRoute(deps.redisClient, user.id);
      if (pendingRoute) {
        // ── Direct edit commands: "edit pickup" / "edit destination" ──
        if (isEditPickupCommand(incomingMessage)) {
          await setBookingStage(deps.redisClient, user.id, 'editing_pickup');
          const reply = `Current pickup: *${pendingRoute.pickupAddress}*\n\nSend a new pickup location pin 📍 or type the address.`;
          await appendWhatsappConversation(deps.redisClient, phone, [
            { role: 'user', content: incomingMessage },
            { role: 'assistant', content: reply },
          ]);
          await sendMetaReply(deps, phone, reply);
          return;
        }

        if (isEditDestinationCommand(incomingMessage)) {
          await setBookingStage(deps.redisClient, user.id, 'editing_destination');
          const reply = `Current destination: *${pendingRoute.destAddress}*\n\nSend a new destination location pin 📍 or type the address.`;
          await appendWhatsappConversation(deps.redisClient, phone, [
            { role: 'user', content: incomingMessage },
            { role: 'assistant', content: reply },
          ]);
          await sendMetaReply(deps, phone, reply);
          return;
        }

        // ── LLM fallback: "change pickup to XYZ" with address inline ──
        const recentMsgs = await getWhatsappConversation(deps.redisClient, phone);
        const groqForEdit = new GroqClient({
          apiKey: deps.groqApiKey,
          model: deps.groqModel,
          timeoutMs: deps.groqTimeoutMs,
        });
        const editIntent = await parseRideIntent(groqForEdit, incomingMessage, recentMsgs);

        if (editIntent?.intent === 'edit_pickup' && editIntent.pickup?.address.trim()) {
          const pickupGeo = await geocodeAddress(deps.googleMapsApiKey, editIntent.pickup.address);
          if (!pickupGeo) {
            const reply = `Could not find "${editIntent.pickup.address}" on the map.\n\nPlease try a more specific pickup address.`;
            await appendWhatsappConversation(deps.redisClient, phone, [
              { role: 'user', content: incomingMessage },
              { role: 'assistant', content: reply },
            ]);
            await sendMetaReply(deps, phone, reply);
            return;
          }

          const pickup = { lat: pickupGeo.lat, lng: pickupGeo.lng, address: pickupGeo.formattedAddress };
          const destination = { lat: pendingRoute.destLat, lng: pendingRoute.destLng, address: pendingRoute.destAddress };

          const plannedRoute = await deps.routePlanner.planRoute({ origin: pickup, destination });
          const distanceKm = plannedRoute.distanceKm;
          const durationMin = Math.ceil(plannedRoute.durationSeconds / 60);
          const suggestedFare = plannedRoute.suggestedFareNgn;
          const minFare = plannedRoute.minOfferNgn;

          await storePendingRoute(deps.redisClient, user.id, {
            pickupLat: pickup.lat,
            pickupLng: pickup.lng,
            pickupAddress: pickup.address,
            destLat: destination.lat,
            destLng: destination.lng,
            destAddress: destination.address,
            distanceKm,
            durationSeconds: plannedRoute.durationSeconds,
            suggestedFareNgn: suggestedFare,
            minOfferNgn: minFare,
            ratePerKmNgn: plannedRoute.ratePerKmNgn,
            route: plannedRoute.geometry,
          });

          const reply = [
            `Pickup: *${pickup.address}*`,
            ``,
            `Destination: *${destination.address}*`,
            ``,
            `${distanceKm.toFixed(1)} km · ~${durationMin} min`,
            `Minimum fare: ₦${minFare.toLocaleString()}`,
            `Suggested fare: ₦${suggestedFare.toLocaleString()}`,
            ``,
            `Negotiate your price and we'll find you a driver!`,
            `Send your offer (e.g. *${suggestedFare.toLocaleString()}* or *${Math.round(suggestedFare * 0.85).toLocaleString()}*)`,
          ].join('\n');

          await appendWhatsappConversation(deps.redisClient, phone, [
            { role: 'user', content: incomingMessage },
            { role: 'assistant', content: reply },
          ]);
          await sendMetaReply(deps, phone, reply);
          return;
        }

        if (editIntent?.intent === 'edit_destination' && editIntent.destination?.address.trim()) {
          const destGeo = await geocodeAddress(deps.googleMapsApiKey, editIntent.destination.address);
          if (!destGeo) {
            const reply = `Could not find "${editIntent.destination.address}" on the map.\n\nPlease try a more specific destination address.`;
            await appendWhatsappConversation(deps.redisClient, phone, [
              { role: 'user', content: incomingMessage },
              { role: 'assistant', content: reply },
            ]);
            await sendMetaReply(deps, phone, reply);
            return;
          }

          const pickup = { lat: pendingRoute.pickupLat, lng: pendingRoute.pickupLng, address: pendingRoute.pickupAddress };
          const destination = { lat: destGeo.lat, lng: destGeo.lng, address: destGeo.formattedAddress };

          const plannedRoute = await deps.routePlanner.planRoute({ origin: pickup, destination });
          const distanceKm = plannedRoute.distanceKm;
          const durationMin = Math.ceil(plannedRoute.durationSeconds / 60);
          const suggestedFare = plannedRoute.suggestedFareNgn;
          const minFare = plannedRoute.minOfferNgn;

          await storePendingRoute(deps.redisClient, user.id, {
            pickupLat: pickup.lat,
            pickupLng: pickup.lng,
            pickupAddress: pickup.address,
            destLat: destination.lat,
            destLng: destination.lng,
            destAddress: destination.address,
            distanceKm,
            durationSeconds: plannedRoute.durationSeconds,
            suggestedFareNgn: suggestedFare,
            minOfferNgn: minFare,
            ratePerKmNgn: plannedRoute.ratePerKmNgn,
            route: plannedRoute.geometry,
          });

          const reply = [
            `Pickup: *${pickup.address}*`,
            ``,
            `Destination: *${destination.address}*`,
            ``,
            `${distanceKm.toFixed(1)} km · ~${durationMin} min`,
            `Minimum fare: ₦${minFare.toLocaleString()}`,
            `Suggested fare: ₦${suggestedFare.toLocaleString()}`,
            ``,
            `Negotiate your price and we'll find you a driver!`,
            `Send your offer (e.g. *${suggestedFare.toLocaleString()}* or *${Math.round(suggestedFare * 0.85).toLocaleString()}*)`,
          ].join('\n');

          await appendWhatsappConversation(deps.redisClient, phone, [
            { role: 'user', content: incomingMessage },
            { role: 'assistant', content: reply },
          ]);
          await sendMetaReply(deps, phone, reply);
          return;
        }

        const offerNgn = parseCounterOffer(incomingMessage);

        if (offerNgn === null) {
          const reply = `Please send a price for your ride.\n\nMinimum: ₦${pendingRoute.minOfferNgn.toLocaleString()}\nSuggested: ₦${pendingRoute.suggestedFareNgn.toLocaleString()}\n\nExample: *${pendingRoute.suggestedFareNgn.toLocaleString()}*`;
          await appendWhatsappConversation(deps.redisClient, phone, [
            { role: 'user', content: incomingMessage },
            { role: 'assistant', content: reply },
          ]);
          await sendMetaReply(deps, phone, reply);
          return;
        }

        if (offerNgn < pendingRoute.minOfferNgn) {
          const reply = `Your offer ₦${offerNgn.toLocaleString()} is below the minimum fare of ₦${pendingRoute.minOfferNgn.toLocaleString()}.\n\nPlease send a higher amount.`;
          await appendWhatsappConversation(deps.redisClient, phone, [
            { role: 'user', content: incomingMessage },
            { role: 'assistant', content: reply },
          ]);
          await sendMetaReply(deps, phone, reply);
          return;
        }

        // Check wallet balance before booking
        const wallet = await walletClient.findByUserId(user.id);
        const balance = wallet ? Number(wallet.balanceNgn) : 0;

        if (!wallet || balance < offerNgn) {
          const shortage = offerNgn - balance;
          const va = await virtualAccountClient.findByUserId(user.id);

          const lines = [
            `Your wallet balance is ₦${balance.toLocaleString()} but the ride costs ₦${offerNgn.toLocaleString()}.`,
            ``,
            `You need ₦${shortage.toLocaleString()} more.`,
          ];

          if (va) {
            lines.push(
              ``,
              `Top up your wallet:`,
              `Bank: *${va.bankName}*`,
              `Account: *${va.accountNumber}*`,
              `Name: *${va.accountName}*`,
              ``,
              `Once funded, send your offer again (e.g. *${offerNgn.toLocaleString()}*).`,
            );
          } else {
            lines.push(``, `Please top up your wallet and try again.`);
          }

          const reply = lines.join('\n');
          await appendWhatsappConversation(deps.redisClient, phone, [
            { role: 'user', content: incomingMessage },
            { role: 'assistant', content: reply },
          ]);
          await sendMetaReply(deps, phone, reply);
          return;
        }

        // Lock funds in wallet
        const rideId = randomUUID();

        try {
          await walletClient.createRideHold({
            rideId,
            walletId: wallet.id,
            riderId: user.id,
            amountNgn: offerNgn,
          });
        } catch {
          const reply = 'Could not lock funds in your wallet. Please try again.';
          await appendWhatsappConversation(deps.redisClient, phone, [
            { role: 'user', content: incomingMessage },
            { role: 'assistant', content: reply },
          ]);
          await sendMetaReply(deps, phone, reply);
          return;
        }

        // Funds locked — publish the ride
        await clearPendingRoute(deps.redisClient, user.id);
        await clearBookingStage(deps.redisClient, user.id);

        const event = RideRequestedEvent.parse({
          eventType: 'RIDE_REQUESTED',
          rideId,
          riderId: user.id,
          pickup: { lat: pendingRoute.pickupLat, lng: pendingRoute.pickupLng, address: pendingRoute.pickupAddress },
          destination: { lat: pendingRoute.destLat, lng: pendingRoute.destLng, address: pendingRoute.destAddress },
          stops: [],
          plannedDistanceKm: pendingRoute.distanceKm,
          plannedDurationSeconds: pendingRoute.durationSeconds,
          fareEstimateNgn: offerNgn,
          paymentMethod: 'WALLET',
          riderOfferNgn: offerNgn,
          suggestedFareNgn: pendingRoute.suggestedFareNgn,
          minOfferNgn: pendingRoute.minOfferNgn,
          ratePerKmNgn: pendingRoute.ratePerKmNgn,
          route: pendingRoute.route,
          timestamp: new Date().toISOString(),
        });

        await deps.publisher.publishRideEvent(event);

        await storeWhatsappRide(deps.redisClient, rideId, {
          riderId: user.id,
          phone,
          pickupAddress: pendingRoute.pickupAddress,
          pickupLat: pendingRoute.pickupLat,
          pickupLng: pendingRoute.pickupLng,
          destinationAddress: pendingRoute.destAddress,
          destinationLat: pendingRoute.destLat,
          destinationLng: pendingRoute.destLng,
          distanceKm: pendingRoute.distanceKm,
          durationSeconds: pendingRoute.durationSeconds,
          offerNgn,
          suggestedFareNgn: pendingRoute.suggestedFareNgn,
          paymentMethod: 'WALLET',
          createdAt: new Date().toISOString(),
        });
        await setActiveRide(deps.redisClient, user.id, rideId);

        const reply = [
          `💰 *₦${offerNgn.toLocaleString()} locked from your wallet*`,
          ``,
          `🔍 *Finding you a driver!*`,
          ``,
          `Pickup: *${pendingRoute.pickupAddress}*`,
          ``,
          `Destination: *${pendingRoute.destAddress}*`,
          ``,
          `We'll send you all available drivers! 🚗`,
        ].join('\n');

        await appendWhatsappConversation(deps.redisClient, phone, [
          { role: 'user', content: incomingMessage },
          { role: 'assistant', content: reply },
        ]);
        await sendMetaReply(deps, phone, reply);
        return;
      }
    }

    // ══════════════════════════════════════════════════════════════════════
    // 5. CANCEL RIDE (via LLM intent or direct text, no active ride)
    // ══════════════════════════════════════════════════════════════════════

    if (isCancelCommand(incomingMessage)) {
      // Clear any pending state
      await clearPendingLocation(deps.redisClient, user.id);
      await clearBookingStage(deps.redisClient, user.id);
      await clearPendingRoute(deps.redisClient, user.id);

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

    // ── Edit pickup/destination with no pending route → tell user to start fresh ──
    if (rideIntent?.intent === 'edit_pickup' || rideIntent?.intent === 'edit_destination') {
      const reply = 'No ride in progress to edit. Start a new ride by typing:\n\n*"From [pickup] to [destination]"*\n\nOr share a location pin 📍';
      await appendWhatsappConversation(deps.redisClient, phone, [
        { role: 'user', content: incomingMessage },
        { role: 'assistant', content: reply },
      ]);
      await sendMetaReply(deps, phone, reply);
      return;
    }

    if (rideIntent?.intent === 'ride_request') {
      const hasPickup = rideIntent.pickup?.specific && rideIntent.pickup.address.trim();
      const hasDestination = rideIntent.destination?.specific && rideIntent.destination.address.trim();

      // ── Both pickup & destination typed → geocode both and plan route ──
      if (hasPickup && hasDestination) {
        const [pickupGeo, destGeo] = await Promise.all([
          geocodeAddress(deps.googleMapsApiKey, rideIntent.pickup!.address),
          geocodeAddress(deps.googleMapsApiKey, rideIntent.destination!.address),
        ]);

        if (!pickupGeo) {
          const reply = `Could not find "${rideIntent.pickup!.address}" on the map.\n\nPlease try a more specific pickup address, or share a location pin 📍`;
          await appendWhatsappConversation(deps.redisClient, phone, [
            { role: 'user', content: incomingMessage },
            { role: 'assistant', content: reply },
          ]);
          await sendMetaReply(deps, phone, reply);
          return;
        }

        if (!destGeo) {
          // Pickup worked — save it and ask for destination again
          await setPendingLocation(deps.redisClient, user.id, {
            lat: pickupGeo.lat,
            lng: pickupGeo.lng,
            address: pickupGeo.formattedAddress,
            savedAt: new Date().toISOString(),
          });
          await setBookingStage(deps.redisClient, user.id, 'awaiting_destination');

          const reply = `📍 Pickup: *${pickupGeo.formattedAddress}*\n\nCould not find "${rideIntent.destination!.address}" on the map.\n\nPlease type a more specific destination or share a destination location pin 📍`;
          await appendWhatsappConversation(deps.redisClient, phone, [
            { role: 'user', content: incomingMessage },
            { role: 'assistant', content: reply },
          ]);
          await sendMetaReply(deps, phone, reply);
          return;
        }

        // Both geocoded — plan route and ask for price
        const pickup = { lat: pickupGeo.lat, lng: pickupGeo.lng, address: pickupGeo.formattedAddress };
        const destination = { lat: destGeo.lat, lng: destGeo.lng, address: destGeo.formattedAddress };

        const plannedRoute = await deps.routePlanner.planRoute({ origin: pickup, destination });
        const distanceKm = plannedRoute.distanceKm;
        const durationMin = Math.ceil(plannedRoute.durationSeconds / 60);
        const suggestedFare = plannedRoute.suggestedFareNgn;
        const minFare = plannedRoute.minOfferNgn;

        await storePendingRoute(deps.redisClient, user.id, {
          pickupLat: pickup.lat,
          pickupLng: pickup.lng,
          pickupAddress: pickup.address,
          destLat: destination.lat,
          destLng: destination.lng,
          destAddress: destination.address,
          distanceKm,
          durationSeconds: plannedRoute.durationSeconds,
          suggestedFareNgn: suggestedFare,
          minOfferNgn: minFare,
          ratePerKmNgn: plannedRoute.ratePerKmNgn,
          route: plannedRoute.geometry,
        });

        // If rider already included a price and it meets minimum, skip awaiting_price
        if (rideIntent.offerNgn && rideIntent.offerNgn >= minFare) {
          await clearPendingRoute(deps.redisClient, user.id);

          const rideId = randomUUID();
          const event = RideRequestedEvent.parse({
            eventType: 'RIDE_REQUESTED',
            rideId,
            riderId: user.id,
            pickup,
            destination,
            stops: [],
            plannedDistanceKm: distanceKm,
            plannedDurationSeconds: plannedRoute.durationSeconds,
            fareEstimateNgn: suggestedFare,
            paymentMethod: 'WALLET',
            riderOfferNgn: rideIntent.offerNgn,
            suggestedFareNgn: suggestedFare,
            minOfferNgn: minFare,
            ratePerKmNgn: plannedRoute.ratePerKmNgn,
            route: plannedRoute.geometry,
            timestamp: new Date().toISOString(),
          });

          await deps.publisher.publishRideEvent(event);

          await storeWhatsappRide(deps.redisClient, rideId, {
            riderId: user.id,
            phone,
            pickupAddress: pickup.address,
            pickupLat: pickup.lat,
            pickupLng: pickup.lng,
            destinationAddress: destination.address,
            destinationLat: destination.lat,
            destinationLng: destination.lng,
            distanceKm,
            durationSeconds: plannedRoute.durationSeconds,
            offerNgn: rideIntent.offerNgn,
            suggestedFareNgn: suggestedFare,
            paymentMethod: 'WALLET',
            createdAt: new Date().toISOString(),
          });
          await setActiveRide(deps.redisClient, user.id, rideId);

          const reply = [
            `🔍 *Finding you a driver!*`,
            ``,
            `Pickup: *${pickup.address}*`,
            `Destination: *${destination.address}*`,
            `${distanceKm.toFixed(1)} km · ~${durationMin} min`,
            `Your offer: ₦${rideIntent.offerNgn.toLocaleString()}`,
            ``,
            `We'll send you all available drivers! 🚗`,
          ].join('\n');

          await appendWhatsappConversation(deps.redisClient, phone, [
            { role: 'user', content: incomingMessage },
            { role: 'assistant', content: reply },
          ]);
          await sendMetaReply(deps, phone, reply);
          return;
        }

        await setBookingStage(deps.redisClient, user.id, 'awaiting_price');

        const reply = [
          `Pickup: *${pickup.address}*`,
          ``,
          `Destination: *${destination.address}*`,
          ``,
          `${distanceKm.toFixed(1)} km · ~${durationMin} min`,
          `Minimum fare: ₦${minFare.toLocaleString()}`,
          `Suggested fare: ₦${suggestedFare.toLocaleString()}`,
          ``,
          `Negotiate your price and we'll find you a driver!`,
          `Send your offer (e.g. *${suggestedFare.toLocaleString()}* or *${Math.round(suggestedFare * 0.85).toLocaleString()}*)`,
        ].join('\n');

        await appendWhatsappConversation(deps.redisClient, phone, [
          { role: 'user', content: incomingMessage },
          { role: 'assistant', content: reply },
        ]);
        await sendMetaReply(deps, phone, reply);
        return;
      }

      // ── Only pickup typed → save it, ask for destination ──
      if (hasPickup) {
        const pickupGeo = await geocodeAddress(deps.googleMapsApiKey, rideIntent.pickup!.address);
        if (pickupGeo) {
          await setPendingLocation(deps.redisClient, user.id, {
            lat: pickupGeo.lat,
            lng: pickupGeo.lng,
            address: pickupGeo.formattedAddress,
            savedAt: new Date().toISOString(),
          });
          await setBookingStage(deps.redisClient, user.id, 'awaiting_destination');

          const reply = `📍 Pickup: *${pickupGeo.formattedAddress}*\n\nNow send your *destination* — type the address or share a location pin 📍`;
          await appendWhatsappConversation(deps.redisClient, phone, [
            { role: 'user', content: incomingMessage },
            { role: 'assistant', content: reply },
          ]);
          await sendMetaReply(deps, phone, reply);
          return;
        }
      }

      // ── Only destination typed, or addresses not specific enough → ask for pickup ──
      const reply = 'To book a ride, type your pickup and destination like:\n\n*"From [pickup address] to [destination]"*\n\nOr share your pickup location pin 📍';
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
