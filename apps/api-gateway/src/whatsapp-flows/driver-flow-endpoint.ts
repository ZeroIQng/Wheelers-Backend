import type { IncomingMessage, ServerResponse } from 'http';
import { driverClient } from '@wheleers/db';
import { RideCounterOfferEvent, RideDriverRejectedEvent } from '@wheleers/kafka-schemas';
import type { GatewayPublisher } from '../websocket/publisher';
import type { RedisClient } from '../redis/client';
import { readRawBody, sendJson } from '../http/utils';
import { decryptFlowRequest, encryptFlowResponse, verifyFlowToken } from './encryption';
import type { FlowRequestBody } from './encryption';
import {
  getDriverProfile,
  getDriverOffers,
  removeDriverOffer,
} from './driver-state';
import type { WhatsappDriverOffer } from './driver-state';
import {
  buildRideOfferListData,
  buildRideOfferDetailData,
  buildDriverCounterOfferData,
  buildDriverConfirmationData,
  buildNoOffersData,
  buildDriverErrorData,
} from './driver-flow-screens';

export interface DriverFlowEndpointDeps {
  redisClient: RedisClient;
  publisher: GatewayPublisher;
  privateKeyPem: string;
  tokenSecret: string;
}

const POLL_INTERVAL_MS = 1_000;
const POLL_MAX_MS = 4_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollForOffers(
  redis: RedisClient,
  userId: string,
  knownCount: number,
): Promise<WhatsappDriverOffer[]> {
  const deadline = Date.now() + POLL_MAX_MS;

  while (Date.now() < deadline) {
    const offers = await getDriverOffers(redis, userId);
    if (offers.length > knownCount) return offers;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return offers;
    await sleep(Math.min(POLL_INTERVAL_MS, remaining));
  }

  return getDriverOffers(redis, userId);
}

function parseFlowToken(flowToken: string, secret: string): { userId: string } | null {
  const payload = verifyFlowToken(flowToken, secret);
  if (!payload) return null;
  const trimmed = payload.trim();
  if (!trimmed) return null;
  return { userId: trimmed };
}

async function handleDriverFlowAction(
  body: FlowRequestBody,
  deps: DriverFlowEndpointDeps,
): Promise<{ screen: string; data: Record<string, unknown> }> {
  if (body.action === 'ping') {
    return { screen: 'SUCCESS', data: { status: 'active' } };
  }

  const tokenData = parseFlowToken(body.flow_token, deps.tokenSecret);
  if (!tokenData) {
    return { screen: 'CONFIRMATION', data: buildDriverErrorData('Invalid session. Please try again.') };
  }

  const { userId } = tokenData;
  const profile = await getDriverProfile(deps.redisClient, userId);
  if (!profile) {
    return { screen: 'CONFIRMATION', data: buildDriverErrorData('You are not online. Send "go online" to start receiving rides.') };
  }

  // INIT — show ride offer list, poll for offers
  if (body.action === 'INIT') {
    const immediate = await getDriverOffers(deps.redisClient, userId);
    if (immediate.length > 0) {
      return { screen: 'RIDE_OFFERS', data: buildRideOfferListData(immediate) };
    }
    const offers = await pollForOffers(deps.redisClient, userId, 0);
    if (offers.length === 0) {
      return { screen: 'RIDE_OFFERS', data: buildNoOffersData() };
    }
    return { screen: 'RIDE_OFFERS', data: buildRideOfferListData(offers) };
  }

  // BACK — return to offer list
  if (body.action === 'BACK') {
    const current = await getDriverOffers(deps.redisClient, userId);
    const offers = await pollForOffers(deps.redisClient, userId, current.length);
    return { screen: 'RIDE_OFFERS', data: buildRideOfferListData(offers) };
  }

  // data_exchange — handle driver actions
  if (body.action === 'data_exchange') {
    const data = body.data ?? {};
    const targetScreen = data.screen as string | undefined;
    const action = data.action as string | undefined;

    // Navigate to ride offer detail
    if (targetScreen === 'RIDE_DETAIL' && data.selected_offer) {
      const offers = await getDriverOffers(deps.redisClient, userId);
      const offerId = data.selected_offer as string;
      const offerIndex = parseInt(offerId.replace('offer-', ''), 10);
      const offer = offers[offerIndex];

      if (!offer) {
        return { screen: 'RIDE_OFFERS', data: buildRideOfferListData(offers) };
      }

      return { screen: 'RIDE_DETAIL', data: buildRideOfferDetailData(offer, offerIndex) };
    }

    // Accept ride at rider's price (driver:accept — same as counter-offer at rider's price)
    if (action === 'accept_ride' && data.offer_id) {
      const offers = await getDriverOffers(deps.redisClient, userId);
      const offerIndex = parseInt((data.offer_id as string).replace('offer-', ''), 10);
      const offer = offers[offerIndex];

      if (!offer) {
        return { screen: 'CONFIRMATION', data: buildDriverErrorData('This ride request has expired.') };
      }

      // Look up driver info from DB for the counter-offer event
      const driverRecord = await driverClient.findByUserId(userId).catch(() => null);

      const event = RideCounterOfferEvent.parse({
        eventType: 'RIDE_COUNTER_OFFER',
        rideId: offer.rideId,
        riderId: offer.riderId,
        driverId: profile.driverId,
        driverUserId: userId,
        counterOfferNgn: offer.riderOfferNgn,
        driverName: profile.name,
        driverRating: driverRecord?.rating ?? profile.rating,
        vehiclePlate: driverRecord?.vehiclePlate ?? profile.vehiclePlate,
        vehicleModel: driverRecord?.vehicleModel ?? profile.vehicleModel,
        etaSeconds: 0,
        timestamp: new Date().toISOString(),
      });

      await deps.publisher.publishRideEvent(event);
      await removeDriverOffer(deps.redisClient, userId, offer.rideId);

      return {
        screen: 'CONFIRMATION',
        data: buildDriverConfirmationData(offer.pickupAddress, offer.destinationAddress, offer.riderOfferNgn),
      };
    }

    // Counter-offer with driver's own price
    if (action === 'counter_offer' && data.counter_amount && data.offer_id) {
      const counterAmount = Number(data.counter_amount);
      const offers = await getDriverOffers(deps.redisClient, userId);
      const offerIndex = parseInt((data.offer_id as string).replace('offer-', ''), 10);
      const offer = offers[offerIndex];

      if (!offer) {
        return { screen: 'RIDE_OFFERS', data: buildRideOfferListData(offers) };
      }

      if (isNaN(counterAmount) || counterAmount < 100 || counterAmount > 1_000_000) {
        return {
          screen: 'COUNTER_OFFER',
          data: { ...buildDriverCounterOfferData(offer, offerIndex), error: 'Enter an amount between ₦100 and ₦1,000,000' },
        };
      }

      const driverRecord = await driverClient.findByUserId(userId).catch(() => null);

      const event = RideCounterOfferEvent.parse({
        eventType: 'RIDE_COUNTER_OFFER',
        rideId: offer.rideId,
        riderId: offer.riderId,
        driverId: profile.driverId,
        driverUserId: userId,
        counterOfferNgn: counterAmount,
        driverName: profile.name,
        driverRating: driverRecord?.rating ?? profile.rating,
        vehiclePlate: driverRecord?.vehiclePlate ?? profile.vehiclePlate,
        vehicleModel: driverRecord?.vehicleModel ?? profile.vehicleModel,
        etaSeconds: 0,
        timestamp: new Date().toISOString(),
      });

      await deps.publisher.publishRideEvent(event);
      await removeDriverOffer(deps.redisClient, userId, offer.rideId);

      return {
        screen: 'RIDE_OFFERS',
        data: {
          ...buildRideOfferListData(await getDriverOffers(deps.redisClient, userId)),
          bid_sent: `Your bid of ₦${counterAmount.toLocaleString()} has been sent!`,
        },
      };
    }

    // Reject ride
    if (action === 'reject_ride' && data.offer_id) {
      const offers = await getDriverOffers(deps.redisClient, userId);
      const offerIndex = parseInt((data.offer_id as string).replace('offer-', ''), 10);
      const offer = offers[offerIndex];

      if (offer) {
        const event = RideDriverRejectedEvent.parse({
          eventType: 'RIDE_DRIVER_REJECTED',
          rideId: offer.rideId,
          riderId: offer.riderId,
          driverId: profile.driverId,
          reason: 'manual_reject',
          timestamp: new Date().toISOString(),
        });

        await deps.publisher.publishRideEvent(event);
        await removeDriverOffer(deps.redisClient, userId, offer.rideId);
      }

      const remaining = await getDriverOffers(deps.redisClient, userId);
      return { screen: 'RIDE_OFFERS', data: buildRideOfferListData(remaining) };
    }

    // Navigate to counter offer screen
    if ((targetScreen === 'COUNTER_OFFER' || action === 'counter_offer_nav') && data.offer_id) {
      const offers = await getDriverOffers(deps.redisClient, userId);
      const offerIndex = parseInt((data.offer_id as string).replace('offer-', ''), 10);
      const offer = offers[offerIndex];

      if (!offer) {
        return { screen: 'RIDE_OFFERS', data: buildRideOfferListData(offers) };
      }

      return { screen: 'COUNTER_OFFER', data: buildDriverCounterOfferData(offer, offerIndex) };
    }

    // Default: show offer list
    const current = await getDriverOffers(deps.redisClient, userId);
    const offers = await pollForOffers(deps.redisClient, userId, current.length);
    return { screen: 'RIDE_OFFERS', data: buildRideOfferListData(offers) };
  }

  return { screen: 'CONFIRMATION', data: buildDriverErrorData('Something went wrong. Please try again.') };
}

export async function handleDriverFlowEndpoint(
  req: IncomingMessage,
  res: ServerResponse,
  deps: DriverFlowEndpointDeps,
): Promise<void> {
  try {
    const rawBody = await readRawBody(req);
    const envelope = JSON.parse(rawBody.toString('utf8'));

    const { decryptedBody, aesKey, iv } = decryptFlowRequest(envelope, deps.privateKeyPem);

    const response = await handleDriverFlowAction(decryptedBody, deps);

    const encrypted = encryptFlowResponse(response, aesKey, iv);
    res.statusCode = 200;
    res.setHeader('content-type', 'text/plain');
    res.end(encrypted);
  } catch (error) {
    console.error('[driver-flow] Endpoint error', error);
    sendJson(res, 500, { error: 'Internal error' });
  }
}
