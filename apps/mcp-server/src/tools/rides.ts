import { randomUUID } from 'crypto';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { GatewayError } from '../gateway/client';
import { LIVE_PHASES, type RideBid, type RideState } from '../gateway/ride-session';
import {
  fail,
  guard,
  LocationSchema,
  locationShape,
  ok,
  paginationShape,
  resolveLocation,
  ToolError,
  type ToolContext,
} from './common';

const ACTIVE_DB_STATUSES = new Set(['REQUESTED', 'MATCHING', 'DRIVER_ASSIGNED', 'DRIVER_EN_ROUTE', 'ARRIVED', 'IN_PROGRESS']);

/** Bidding lasts ~3 minutes on the ride-service; a session still "bidding" well past that never got its timeout event. */
const STALE_BIDDING_MS = 15 * 60 * 1000;

function sessionIsLive(state: RideState | null): boolean {
  if (!state || !LIVE_PHASES.has(state.phase)) return false;
  if (state.phase === 'bidding' && Date.now() - new Date(state.createdAt).getTime() > STALE_BIDDING_MS) return false;
  return true;
}

interface RideDetail {
  id: string;
  status: string;
  driver: { id: string; userId: string; name: string | null } | null;
  [key: string]: unknown;
}

function summarizeBids(state: RideState | null): RideBid[] {
  if (!state) return [];
  return Object.values(state.bids).sort((a, b) => a.counterOfferNgn - b.counterOfferNgn);
}

function liveSummary(state: RideState | null, listening: boolean) {
  if (!state) return null;
  return {
    phase: state.phase,
    listeningForUpdates: listening,
    riderOfferNgn: state.request?.['riderOfferNgn'] ?? null,
    bids: summarizeBids(state),
    riderCounterOffers: state.riderCounterOffers,
    matched: state.matched ?? null,
    driverLocation: state.driverLocation ?? null,
    driverRejections: state.driverRejections,
    recentMessages: state.messages.slice(-10),
    recentEvents: state.events.slice(-15),
    updatedAt: state.updatedAt,
  };
}

async function loadRideDetail(ctx: ToolContext, rideId: string): Promise<RideDetail | null> {
  try {
    const result = await ctx.gw.get<{ ride: RideDetail }>(`/rides/${encodeURIComponent(rideId)}`);
    return result.ride;
  } catch (error) {
    if (error instanceof GatewayError && error.status === 404) return null;
    throw error;
  }
}

async function resolveRideId(ctx: ToolContext, rideId?: string): Promise<string | null> {
  if (rideId) return rideId;
  const fromSession = await ctx.rides.getActiveRideId(ctx.userId);
  if (fromSession) return fromSession;
  const active = await ctx.gw.get<{ ride: RideDetail | null }>('/rides/active');
  return active.ride?.id ?? null;
}

function phaseHint(state: RideState | null, detail: RideDetail | null): string {
  const phase = state?.phase;
  if (phase === 'bidding') {
    const count = state ? Object.keys(state.bids).length : 0;
    return count > 0
      ? `${count} driver bid(s) received. Present them to the user (price, ETA, rating, vehicle) and call accept_ride_offer with the chosen driverId, or counter_ride_offer to negotiate.`
      : 'Waiting for drivers to bid. Check again in 20–30 seconds with get_ride_status or list_ride_offers. Bidding times out after a few minutes if nobody responds.';
  }
  if (phase === 'matched') return 'A driver accepted and is on the way to the pickup. Share driver name, vehicle, plate and ETA with the user.';
  if (phase === 'arrived') return 'The driver has arrived at the pickup point.';
  if (phase === 'in_progress') return 'The trip is in progress.';
  if (phase === 'completed') return 'The trip is complete. Offer to rate the driver with rate_ride.';
  if (phase === 'cancelled') return 'The ride was cancelled.';
  if (phase === 'bid_timeout') return 'No driver accepted in time. Suggest trying again, possibly with a higher offer.';
  if (detail) return `Ride status from Wheelers: ${detail.status}.`;
  return 'No live information for this ride.';
}

export function registerRideTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'resolve_location',
    {
      title: 'Find a place on the map',
      description: 'Geocode a free-text place/address into candidates with coordinates. Use when a location is ambiguous or to confirm what the user means before booking.',
      inputSchema: {
        query: z.string().min(2).describe('Place name or address, e.g. "Ikeja City Mall".'),
        limit: z.number().int().min(1).max(5).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) =>
      guard(async () => {
        if (!ctx.geocoder) return fail('Geocoding is not configured on this server. Provide lat/lng directly.');
        const candidates = await ctx.geocoder.candidates(args.query, args.limit ?? 3);
        return ok({ query: args.query, candidates });
      }),
  );

  server.registerTool(
    'estimate_ride',
    {
      title: 'Estimate a ride fare',
      description:
        'Get distance, duration, suggested fare and minimum offer for a trip before booking. Accepts addresses (geocoded) or coordinates. Prices are in Nigerian naira (NGN).',
      inputSchema: {
        pickup: LocationSchema,
        destination: LocationSchema,
        stops: z.array(LocationSchema).max(5).optional().describe('Optional intermediate stops, in order.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) =>
      guard(async () => {
        const pickup = await resolveLocation(ctx, args.pickup, 'Pickup', { pickFirstIfAmbiguous: true });
        const destination = await resolveLocation(ctx, args.destination, 'Destination', { pickFirstIfAmbiguous: true });
        const stops = [];
        for (const [index, stop] of (args.stops ?? []).entries()) {
          stops.push(await resolveLocation(ctx, stop, `Stop ${index + 1}`, { pickFirstIfAmbiguous: true }));
        }
        const estimate = await ctx.gw.post<Record<string, unknown>>('/rides/estimate', { pickup, destination, stops });
        const { route: _route, ...rest } = estimate;
        return ok({
          ...rest,
          resolved: { pickup, destination, stops },
          note: 'Resolved addresses are shown so the user can confirm them before request_ride.',
        });
      }),
  );

  server.registerTool(
    'request_ride',
    {
      title: 'Request a ride',
      description:
        'Book a ride now. Publishes the request to nearby drivers who then bid; the ride is NOT confirmed until the user accepts a bid with accept_ride_offer. ' +
        'Always confirm pickup, destination and the offer price with the user before calling. Fare offer must be at least the minimum from estimate_ride. ' +
        'After calling, poll get_ride_status / list_ride_offers for driver bids.',
      inputSchema: {
        pickup: LocationSchema,
        destination: LocationSchema,
        stops: z.array(LocationSchema).max(5).optional(),
        offerNgn: z.number().positive().optional().describe('Rider\'s fare offer in NGN. Defaults to the suggested fare.'),
        paymentMethod: z.enum(['wallet', 'cash']).optional().describe('Default wallet (in-app balance).'),
        useReferralCashback: z.boolean().optional().describe('Apply available referral cashback to this fare.'),
        requestedReferralCashbackNgn: z.number().positive().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) =>
      guard(async () => {
        const existing = await resolveRideId(ctx);
        if (existing) {
          const state = await ctx.rides.getState(existing);
          const detail = await loadRideDetail(ctx, existing);
          const stillLive = sessionIsLive(state) || (detail !== null && ACTIVE_DB_STATUSES.has(detail.status));
          if (stillLive) {
            return fail('There is already an active ride for this user. Check it with get_ride_status, or cancel it first with cancel_ride.', {
              rideId: existing,
              phase: state?.phase ?? detail?.status ?? null,
            });
          }
          await ctx.rides.clearActiveRide(ctx.userId, existing);
        }

        const pickup = await resolveLocation(ctx, args.pickup, 'Pickup');
        const destination = await resolveLocation(ctx, args.destination, 'Destination');
        const stops = [];
        for (const [index, stop] of (args.stops ?? []).entries()) {
          stops.push(await resolveLocation(ctx, stop, `Stop ${index + 1}`));
        }

        const payload: Record<string, unknown> = {
          rideId: randomUUID(),
          pickup,
          destination,
          stops,
          paymentMethod: args.paymentMethod === 'cash' ? 'CASH' : 'WALLET',
        };
        if (args.offerNgn !== undefined) payload['offerNgn'] = args.offerNgn;
        if (args.useReferralCashback) payload['useReferralCashback'] = true;
        if (args.requestedReferralCashbackNgn !== undefined) payload['requestedReferralCashbackNgn'] = args.requestedReferralCashbackNgn;

        const reply = await ctx.rides.command(
          ctx.userId,
          ctx.gatewayToken,
          'ride:request',
          payload,
          ['ride:request:accepted', 'ride:request:rejected'],
        );

        if (reply.type === 'ride:request:rejected') {
          return fail(String(reply.payload['error'] ?? 'Ride request was rejected.'), {
            suggestedFareNgn: reply.payload['suggestedFareNgn'],
            minOfferNgn: reply.payload['minOfferNgn'],
          });
        }

        const { route: _route, ...accepted } = reply.payload;
        return ok({
          ...accepted,
          resolved: { pickup, destination, stops },
          nextStep:
            'Request published. Drivers are now bidding — wait ~20–30s then call list_ride_offers (or get_ride_status). Bids expire if nobody is accepted within a few minutes.',
        });
      }),
  );

  server.registerTool(
    'get_ride_status',
    {
      title: 'Get ride status',
      description:
        'Current state of a ride: Wheelers record (status, fare, driver) plus live negotiation data (driver bids, match, driver location, recent events). Omit rideId for the user\'s active ride.',
      inputSchema: {
        rideId: z.string().optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) =>
      guard(async () => {
        const rideId = await resolveRideId(ctx, args.rideId);
        if (!rideId) return ok({ activeRide: null, message: 'No active ride. Use estimate_ride then request_ride to book one.' });

        const [detail, state] = await Promise.all([loadRideDetail(ctx, rideId), ctx.rides.getState(rideId)]);
        if (!detail && !state) return fail('Ride not found for this user.', { rideId });

        const isLive = sessionIsLive(state) || (detail !== null && ACTIVE_DB_STATUSES.has(detail.status));
        let listening = ctx.rides.isListening(ctx.userId);
        if (isLive && !listening) {
          listening = await ctx.rides.ensureListening(ctx.userId, ctx.gatewayToken);
        }

        return ok({
          rideId,
          ride: detail,
          live: liveSummary(state, listening),
          hint: phaseHint(state, detail),
        });
      }),
  );

  server.registerTool(
    'list_ride_offers',
    {
      title: 'List driver bids for a ride',
      description: 'Driver counter-offers (bids) received for a ride in the bidding phase, cheapest first. Omit rideId for the active ride.',
      inputSchema: { rideId: z.string().optional() },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) =>
      guard(async () => {
        const rideId = await resolveRideId(ctx, args.rideId);
        if (!rideId) return ok({ bids: [], message: 'No active ride.' });
        const state = await ctx.rides.getState(rideId);
        if (state && LIVE_PHASES.has(state.phase) && !ctx.rides.isListening(ctx.userId)) {
          await ctx.rides.ensureListening(ctx.userId, ctx.gatewayToken);
        }
        return ok({
          rideId,
          phase: state?.phase ?? null,
          riderOfferNgn: state?.request?.['riderOfferNgn'] ?? null,
          bids: summarizeBids(state),
          hint: phaseHint(state, null),
        });
      }),
  );

  server.registerTool(
    'accept_ride_offer',
    {
      title: 'Accept a driver bid',
      description: 'Accept a driver\'s counter-offer from list_ride_offers. This confirms the booking at that price and locks the fare from the wallet. Confirm with the user first.',
      inputSchema: {
        rideId: z.string().optional().describe('Defaults to the active ride.'),
        driverId: z.string().describe('driverId from list_ride_offers.'),
        paymentMethod: z.enum(['wallet', 'cash']).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) =>
      guard(async () => {
        const rideId = await resolveRideId(ctx, args.rideId);
        if (!rideId) return fail('No active ride to accept an offer for.');
        const state = await ctx.rides.getState(rideId);
        const bid = state?.bids[args.driverId];
        if (!bid) {
          return fail('That driver has no bid on this ride (it may have been withdrawn). Call list_ride_offers for current bids.', {
            rideId,
            availableDriverIds: state ? Object.keys(state.bids) : [],
          });
        }

        const reply = await ctx.rides.command(
          ctx.userId,
          ctx.gatewayToken,
          'ride:accept_offer',
          {
            rideId,
            driverId: bid.driverId,
            driverUserId: bid.driverUserId,
            agreedFareNgn: bid.counterOfferNgn,
            paymentMethod: args.paymentMethod === 'cash' ? 'CASH' : 'WALLET',
          },
          ['ride:accept_offer:accepted'],
        );

        return ok({
          ...reply.payload,
          driver: bid,
          nextStep: 'Offer accepted. Wheelers is confirming with the driver — call get_ride_status shortly; phase becomes "matched" with driver details and ETA.',
        });
      }),
  );

  server.registerTool(
    'counter_ride_offer',
    {
      title: 'Counter a driver bid',
      description: 'Send the rider\'s counter-price to a specific bidding driver. Must respect the minimum offer from the estimate.',
      inputSchema: {
        rideId: z.string().optional(),
        driverId: z.string(),
        counterOfferNgn: z.number().positive(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) =>
      guard(async () => {
        const rideId = await resolveRideId(ctx, args.rideId);
        if (!rideId) return fail('No active ride.');
        const reply = await ctx.rides.command(
          ctx.userId,
          ctx.gatewayToken,
          'ride:rider_counter_offer',
          { rideId, driverId: args.driverId, counterOfferNgn: args.counterOfferNgn },
          ['ride:rider_counter_offer:accepted'],
        );
        return ok({ ...reply.payload, nextStep: 'Counter sent to the driver. Watch list_ride_offers for a revised bid.' });
      }),
  );

  server.registerTool(
    'cancel_ride',
    {
      title: 'Cancel a ride',
      description: 'Cancel the active (or given) ride. Cancelling after a driver is matched may incur a penalty. Confirm with the user first.',
      inputSchema: {
        rideId: z.string().optional(),
        reason: z.string().max(200).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async (args) =>
      guard(async () => {
        const rideId = await resolveRideId(ctx, args.rideId);
        if (!rideId) return fail('No active ride to cancel.');
        const payload: Record<string, unknown> = { rideId };
        if (args.reason) payload['reason'] = args.reason;
        const reply = await ctx.rides.command(ctx.userId, ctx.gatewayToken, 'ride:cancel', payload, ['ride:cancel:accepted']);
        await ctx.rides.clearActiveRide(ctx.userId, rideId);
        return ok({ ...reply.payload, cancelled: true });
      }),
  );

  server.registerTool(
    'get_ride_history',
    {
      title: 'Past rides',
      description: 'Completed and cancelled rides for the user, newest first, with fares and timestamps.',
      inputSchema: paginationShape,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => guard(async () => ok(await ctx.gw.get('/rides/history', args))),
  );

  server.registerTool(
    'get_ride_messages',
    {
      title: 'Ride chat history',
      description: 'Messages exchanged with the driver on a ride.',
      inputSchema: { rideId: z.string().optional(), limit: z.number().int().min(1).max(100).optional(), cursor: z.string().optional() },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) =>
      guard(async () => {
        const rideId = await resolveRideId(ctx, args.rideId);
        if (!rideId) return fail('No ride specified and no active ride.');
        return ok(await ctx.gw.get(`/rides/${encodeURIComponent(rideId)}/messages`, { limit: args.limit, cursor: args.cursor }));
      }),
  );

  server.registerTool(
    'send_ride_message',
    {
      title: 'Message the driver',
      description: 'Send a chat message to the driver on the active (or given) ride, e.g. "I\'m at the gate in a red shirt".',
      inputSchema: { rideId: z.string().optional(), content: z.string().min(1).max(1000) },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) =>
      guard(async () => {
        const rideId = await resolveRideId(ctx, args.rideId);
        if (!rideId) return fail('No active ride to message.');
        const reply = await ctx.rides.command(ctx.userId, ctx.gatewayToken, 'chat:send', { rideId, content: args.content }, ['chat:send:accepted']);
        return ok(reply.payload);
      }),
  );

  server.registerTool(
    'rate_ride',
    {
      title: 'Rate the driver',
      description: 'Submit a 1–5 star rating (and optional comment) for the driver of a completed ride.',
      inputSchema: {
        rideId: z.string().optional().describe('Defaults to the most recent ride.'),
        rating: z.number().int().min(1).max(5),
        comment: z.string().max(500).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) =>
      guard(async () => {
        let rideId = args.rideId ?? (await ctx.rides.getActiveRideId(ctx.userId));
        if (!rideId) {
          const history = await ctx.gw.get<{ items: Array<{ id: string; status: string }> }>('/rides/history', { limit: 1 });
          rideId = history.items[0]?.id ?? null;
        }
        if (!rideId) return fail('No ride to rate.');
        const detail = await loadRideDetail(ctx, rideId);
        if (!detail) return fail('Ride not found.', { rideId });
        if (!detail.driver) return fail('This ride has no driver to rate.', { rideId, status: detail.status });

        const payload: Record<string, unknown> = {
          feedbackId: randomUUID(),
          rideId,
          reviewerRole: 'rider',
          revieweeId: detail.driver.userId,
          rating: args.rating,
        };
        if (args.comment) payload['comment'] = args.comment;
        const reply = await ctx.rides.command(ctx.userId, ctx.gatewayToken, 'feedback:submit', payload, ['feedback:submit:accepted']);
        return ok({ ...reply.payload, driverName: detail.driver.name, rating: args.rating });
      }),
  );

  server.registerTool(
    'open_dispute',
    {
      title: 'Open a dispute',
      description: 'Raise a dispute about a ride (wrong fare, driver behaviour, etc.) for the Wheelers team to review. Confirm with the user first.',
      inputSchema: { rideId: z.string(), reason: z.string().min(5).max(1000) },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) =>
      guard(async () => {
        const detail = await loadRideDetail(ctx, args.rideId);
        if (!detail) throw new ToolError('Ride not found.', { rideId: args.rideId });
        if (!detail.driver) throw new ToolError('This ride has no driver to dispute against.', { rideId: args.rideId });
        const reply = await ctx.rides.command(
          ctx.userId,
          ctx.gatewayToken,
          'dispute:open',
          { rideId: args.rideId, openedByRole: 'rider', againstId: detail.driver.userId, reason: args.reason },
          ['dispute:open:accepted'],
        );
        return ok(reply.payload);
      }),
  );
}
