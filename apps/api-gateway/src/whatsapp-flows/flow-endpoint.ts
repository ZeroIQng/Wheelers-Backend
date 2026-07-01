import type { IncomingMessage, ServerResponse } from 'http';
import { RideOfferAcceptedEvent, RideRiderCounterOfferEvent } from '@wheleers/kafka-schemas';
import type { GatewayPublisher } from '../websocket/publisher';
import type { RedisClient } from '../redis/client';
import { readRawBody, sendJson } from '../http/utils';
import { decryptFlowRequest, encryptFlowResponse, verifyFlowToken } from './encryption';
import type { FlowRequestBody } from './encryption';
import { getBids, getRideMeta } from './bid-state';
import type { WhatsappBid } from './bid-state';
import {
  buildBidListData,
  buildBidDetailData,
  buildConfirmationData,
  buildCounterOfferData,
  buildNoBidsData,
  buildErrorData,
} from './flow-screens';

export interface WhatsappFlowEndpointDeps {
  redisClient: RedisClient;
  publisher: GatewayPublisher;
  privateKeyPem: string;
  tokenSecret: string;
}

const POLL_INTERVAL_MS = 1_000;  // check Redis every 1 second
const POLL_MAX_MS = 4_000;       // hold response for up to 4 seconds

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Poll Redis until bids appear or timeout. Returns latest bids. */
async function pollForBids(
  redis: RedisClient,
  rideId: string,
  knownCount: number,
): Promise<WhatsappBid[]> {
  const deadline = Date.now() + POLL_MAX_MS;

  while (Date.now() < deadline) {
    const bids = await getBids(redis, rideId);
    // Return as soon as we have more bids than the caller already knows about
    if (bids.length > knownCount) return bids;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return bids;
    await sleep(Math.min(POLL_INTERVAL_MS, remaining));
  }

  return getBids(redis, rideId);
}

function parseFlowToken(flowToken: string, secret: string): { rideId: string; userId: string } | null {
  const payload = verifyFlowToken(flowToken, secret);
  if (!payload) return null;
  const parts = payload.split(':');
  if (parts.length < 2) return null;
  return { rideId: parts[0], userId: parts[1] };
}

async function handleFlowAction(
  body: FlowRequestBody,
  deps: WhatsappFlowEndpointDeps,
): Promise<{ screen: string; data: Record<string, unknown> }> {
  if (body.action === 'ping') {
    return { screen: 'SUCCESS', data: { status: 'active' } };
  }

  const tokenData = parseFlowToken(body.flow_token, deps.tokenSecret);
  if (!tokenData) {
    return { screen: 'CONFIRMATION', data: buildErrorData('Invalid session. Please try again.') };
  }

  const { rideId, userId } = tokenData;
  const meta = await getRideMeta(deps.redisClient, rideId);
  if (!meta) {
    return { screen: 'CONFIRMATION', data: buildErrorData('This ride request has expired. Send a new message to book a ride.') };
  }

  // INIT — poll for bids when Flow first opens (holds up to 4s waiting for drivers)
  if (body.action === 'INIT') {
    const immediate = await getBids(deps.redisClient, rideId);
    if (immediate.length > 0) {
      return { screen: 'BID_LIST', data: buildBidListData(meta, immediate) };
    }
    // No bids yet — poll Redis for a few seconds so rider sees bids as they arrive
    const bids = await pollForBids(deps.redisClient, rideId, 0);
    if (bids.length === 0) {
      return { screen: 'BID_LIST', data: buildNoBidsData(meta) };
    }
    return { screen: 'BID_LIST', data: buildBidListData(meta, bids) };
  }

  // BACK — poll briefly for any new bids before returning to list
  if (body.action === 'BACK') {
    const current = await getBids(deps.redisClient, rideId);
    const bids = await pollForBids(deps.redisClient, rideId, current.length);
    return { screen: 'BID_LIST', data: buildBidListData(meta, bids) };
  }

  // data_exchange — handle user actions
  if (body.action === 'data_exchange') {
    const data = body.data ?? {};
    const targetScreen = data.screen as string | undefined;
    const action = data.action as string | undefined;

    // Navigate to bid detail
    if (targetScreen === 'BID_DETAIL' && data.selected_bid) {
      const bids = await getBids(deps.redisClient, rideId);
      const bidId = data.selected_bid as string;
      const bidIndex = parseInt(bidId.replace('bid-', ''), 10);
      const bid = bids[bidIndex];

      if (!bid) {
        return { screen: 'BID_LIST', data: buildBidListData(meta, bids) };
      }

      return { screen: 'BID_DETAIL', data: buildBidDetailData(bid, bidIndex) };
    }

    // Accept a bid
    if (action === 'accept_bid' && data.bid_id) {
      const bids = await getBids(deps.redisClient, rideId);
      const bidIndex = parseInt((data.bid_id as string).replace('bid-', ''), 10);
      const bid = bids[bidIndex];

      if (!bid) {
        return { screen: 'CONFIRMATION', data: buildErrorData('This offer is no longer available. Please try again.') };
      }

      // Publish acceptance event — same as WebSocket ride:accept_offer
      const event = RideOfferAcceptedEvent.parse({
        eventType: 'RIDE_OFFER_ACCEPTED',
        rideId,
        riderId: userId,
        driverId: bid.driverId,
        driverUserId: bid.driverUserId,
        agreedFareNgn: bid.counterOfferNgn,
        paymentMethod: meta.paymentMethod,
        timestamp: new Date().toISOString(),
      });

      await deps.publisher.publishRideEvent(event);

      return {
        screen: 'CONFIRMATION',
        data: buildConfirmationData(bid.driverName, bid.vehicleModel, bid.etaSeconds, bid.counterOfferNgn),
      };
    }

    // Counter offer to a specific driver
    if (action === 'counter_offer' && data.counter_amount && data.bid_id) {
      const counterAmount = Number(data.counter_amount);
      const bids = await getBids(deps.redisClient, rideId);
      const bidIndex = parseInt((data.bid_id as string).replace('bid-', ''), 10);
      const bid = bids[bidIndex];

      if (!bid) {
        return { screen: 'BID_LIST', data: buildBidListData(meta, bids) };
      }

      if (isNaN(counterAmount) || counterAmount < 100 || counterAmount > 1_000_000) {
        return {
          screen: 'COUNTER_OFFER',
          data: { ...buildCounterOfferData(meta, bid, bidIndex), error: 'Enter an amount between ₦100 and ₦1,000,000' },
        };
      }

      // Update the global offer in ride meta
      meta.offerNgn = counterAmount;
      await deps.redisClient.set(
        `whatsapp:ride:${rideId}:meta`,
        JSON.stringify(meta),
        900,
      );

      // Publish rider counter-offer to Kafka so the driver gets notified
      const event = RideRiderCounterOfferEvent.parse({
        eventType: 'RIDE_RIDER_COUNTER_OFFER',
        rideId,
        riderId: userId,
        driverId: bid.driverId,
        counterOfferNgn: counterAmount,
        timestamp: new Date().toISOString(),
      });

      await deps.publisher.publishRideEvent(event);

      return {
        screen: 'BID_LIST',
        data: {
          ...buildBidListData(meta, bids),
          counter_sent: `Counter offer of ₦${counterAmount.toLocaleString()} sent to ${bid.driverName}`,
        },
      };
    }

    // Navigate to counter offer screen for a specific driver
    if ((targetScreen === 'COUNTER_OFFER' || action === 'counter_offer_nav') && data.bid_id) {
      const bids = await getBids(deps.redisClient, rideId);
      const bidIndex = parseInt((data.bid_id as string).replace('bid-', ''), 10);
      const bid = bids[bidIndex];

      if (!bid) {
        return { screen: 'BID_LIST', data: buildBidListData(meta, bids) };
      }

      return { screen: 'COUNTER_OFFER', data: buildCounterOfferData(meta, bid, bidIndex) };
    }

    // Default: poll for fresh bids, then show bid list
    const current = await getBids(deps.redisClient, rideId);
    const bids = await pollForBids(deps.redisClient, rideId, current.length);
    return { screen: 'BID_LIST', data: buildBidListData(meta, bids) };
  }

  return { screen: 'CONFIRMATION', data: buildErrorData('Something went wrong. Please try again.') };
}

export async function handleWhatsappFlowEndpoint(
  req: IncomingMessage,
  res: ServerResponse,
  deps: WhatsappFlowEndpointDeps,
): Promise<void> {
  try {
    const rawBody = await readRawBody(req);
    const envelope = JSON.parse(rawBody.toString('utf8'));

    const { decryptedBody, aesKey, iv } = decryptFlowRequest(envelope, deps.privateKeyPem);

    const response = await handleFlowAction(decryptedBody, deps);

    const encrypted = encryptFlowResponse(response, aesKey, iv);
    res.statusCode = 200;
    res.setHeader('content-type', 'text/plain');
    res.end(encrypted);
  } catch (error) {
    console.error('[whatsapp-flow] Endpoint error', error);
    sendJson(res, 500, { error: 'Internal error' });
  }
}
