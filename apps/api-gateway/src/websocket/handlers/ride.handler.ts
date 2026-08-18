import { randomUUID } from 'crypto';
import { GoogleMapsRoutePlanner, validateRiderOffer, calculateSuggestedFare } from '@wheleers/config';
import { chatClient, driverClient, groupRideClient, referralClient, rideClient } from '@wheleers/db';
import {
  ChatMessageSentEvent,
  DisputeOpenedEvent,
  FeedbackLoggedEvent,
  RideCancelledEvent,
  RideCompletionRequestedEvent,
  RideCounterOfferEvent,
  RideDriverRejectedEvent,
  RideOfferAcceptedEvent,
  RideRiderCounterOfferEvent,
  RideRouteUpdateRequestedEvent,
  RideRequestedEvent,
  RideStopConfirmedEvent,
  RideStartedEvent,
} from '@wheleers/kafka-schemas';
import type { GatewayAuthContext } from '../../types';
import { getBoolean, getNumber, getRecord, getString } from '../../utils/object';
import type { GatewayPublisher } from '../publisher';
import type { HandlerResponse } from './types';
import { buildRideEstimatePricing } from '../../pricing/ride-estimate';

interface LatLngAddress {
  lat: number;
  lng: number;
  address: string;
}

function requireString(payload: Record<string, unknown>, key: string): string {
  const value = getString(payload, key);
  if (!value) throw new Error(`Missing required field: ${key}`);
  return value;
}

/**
 * Counter-offers re-open the price after the initial offer was validated, so
 * they have to clear the same bar — otherwise either side can haggle a ride
 * below the minimum fare and the floor only applies to the first offer.
 */
async function assertOfferMeetsMinimum(
  rideId: string,
  offerNgn: number,
  who: 'rider' | 'driver',
): Promise<void> {
  const suggestedFareNgn = await resolveSuggestedFareNgn(rideId);

  // Unknown ride: bidding must not be blocked by a lookup we could not resolve.
  if (suggestedFareNgn === null) {
    console.warn('[api-gateway][ride] could not resolve a fare to validate the counter-offer against', {
      rideId,
      who,
      offerNgn,
    });
    return;
  }

  const validation = validateRiderOffer(offerNgn, suggestedFareNgn);
  if (!validation.valid) {
    console.warn('[api-gateway][ride] counter-offer rejected below minimum', {
      rideId,
      who,
      offerNgn,
      minOfferNgn: validation.minOfferNgn,
      suggestedFareNgn,
    });
    throw new Error(validation.reason ?? `Offer must be at least ${validation.minOfferNgn} NGN.`);
  }
}

/**
 * A group ride's rideId is a GroupRideMatchRequest id, not a Ride id — no Ride
 * row exists for it, so looking only in `Ride` throws and kills bidding on
 * every group ride. Check both, and return null when neither knows the ride.
 */
async function resolveSuggestedFareNgn(rideId: string): Promise<number | null> {
  const ride = await rideClient.findById(rideId).catch(() => null);
  if (ride) {
    return ride.fareEstimateNgn !== null && ride.fareEstimateNgn !== undefined
      ? Number(ride.fareEstimateNgn)
      : 0;
  }

  const groupRequest = await groupRideClient.findMatchRequestById(rideId).catch(() => null);
  if (groupRequest) {
    // Price the group leg off its planned distance where we have it, so the
    // floor applies to group bids the same way it does to solo ones.
    if (groupRequest.plannedDistanceKm) {
      return calculateSuggestedFare(groupRequest.plannedDistanceKm).suggestedFareNgn;
    }
    return groupRequest.fareEstimateNgn !== null && groupRequest.fareEstimateNgn !== undefined
      ? Number(groupRequest.fareEstimateNgn)
      : 0;
  }

  return null;
}

function requireNumber(payload: Record<string, unknown>, key: string): number {
  const value = getNumber(payload, key);
  if (value === undefined) throw new Error(`Missing required field: ${key}`);
  return value;
}

function parseLatLng(payload: Record<string, unknown>, key: string): LatLngAddress {
  const value = getRecord(payload, key);
  if (!value) {
    throw new Error(`Missing required field: ${key}`);
  }

  const lat = getNumber(value, 'lat');
  const lng = getNumber(value, 'lng');
  const address = getString(value, 'address');

  if (lat === undefined || lng === undefined || !address) {
    throw new Error(`Invalid ${key} payload`);
  }

  return { lat, lng, address };
}

function parseStopList(payload: Record<string, unknown>, key: string): LatLngAddress[] {
  const value = payload[key];
  if (value === undefined) {
    return [];
  }

  if (!Array.isArray(value)) {
    throw new Error(`Invalid ${key} payload`);
  }

  return value.map((item, index) => {
    if (!getRecord({ item }, 'item')) {
      throw new Error(`Invalid ${key}[${index}] payload`);
    }

    return parseLatLng({ [key]: item }, key);
  });
}

function parsePaymentMethod(value: unknown): 'CASH' | 'WALLET' {
  const upper = typeof value === 'string' ? value.toUpperCase() : value;
  if (upper === 'CASH') return 'CASH';
  return 'WALLET';
}

function normalizeEndedBy(value: unknown): 'both_confirmed' | 'auto_gps' | 'admin' {
  if (value === 'auto_gps' || value === 'admin') return value;
  return 'both_confirmed';
}

function normalizeReviewerRole(value: unknown): 'rider' | 'driver' {
  if (value === 'driver') return 'driver';
  return 'rider';
}

function normalizeOpenedByRole(value: unknown): 'rider' | 'driver' {
  if (value === 'driver') return 'driver';
  return 'rider';
}

export async function handleRideMessage(
  type: string,
  payload: Record<string, unknown>,
  auth: GatewayAuthContext,
  publisher: GatewayPublisher,
  routePlanner: GoogleMapsRoutePlanner,
): Promise<HandlerResponse | null> {
  const timestamp = new Date().toISOString();

  if (type === 'ride:request') {
    const rideId = getString(payload, 'rideId') ?? randomUUID();
    const pickup = parseLatLng(payload, 'pickup');
    const destination = parseLatLng(payload, 'destination');
    const stops = parseStopList(payload, 'stops');
    const paymentMethod = parsePaymentMethod(payload['paymentMethod']);
    const plannedRoute = await routePlanner.planRoute({
      origin: pickup,
      stops,
      destination,
    });

    const suggestedFareNgn = plannedRoute.suggestedFareNgn;
    const minOfferNgn = plannedRoute.minOfferNgn;
    const ratePerKmNgn = plannedRoute.ratePerKmNgn;

    // Rider's offer — defaults to suggested fare if not provided
    let riderOfferNgn = getNumber(payload, 'offerNgn') ?? suggestedFareNgn;

    // Validate rider's offer
    const validation = validateRiderOffer(riderOfferNgn, suggestedFareNgn);
    if (!validation.valid) {
      return {
        type: 'ride:request:rejected',
        payload: {
          rideId,
          error: validation.reason,
          suggestedFareNgn,
          minOfferNgn: validation.minOfferNgn,
        },
      };
    }

    const useReferralCashback =
      getBoolean(payload, 'useReferralCashback') ?? false;
    const requestedReferralCashbackNgn = getNumber(
      payload,
      'requestedReferralCashbackNgn',
    );
    let referralCashbackAppliedNgn = 0;
    let fareEstimateNgn = suggestedFareNgn;

    if (useReferralCashback) {
      const reservation = await referralClient.reserveRideCashback({
        userId: auth.userId,
        rideId,
        fareNgn: suggestedFareNgn,
        requestedAmountNgn: requestedReferralCashbackNgn,
      });
      referralCashbackAppliedNgn = reservation.reservedCashbackNgn;
      fareEstimateNgn = Math.max(
        0,
        suggestedFareNgn - referralCashbackAppliedNgn,
      );
    }

    const event = RideRequestedEvent.parse({
      eventType: 'RIDE_REQUESTED',
      rideId,
      riderId: auth.userId,
      pickup,
      destination,
      stops,
      plannedDistanceKm: plannedRoute.distanceKm,
      plannedDurationSeconds: plannedRoute.durationSeconds,
      fareEstimateNgn,
      paymentMethod,
      riderOfferNgn,
      suggestedFareNgn,
      minOfferNgn,
      ratePerKmNgn,
      fareBeforeCashbackNgn:
        referralCashbackAppliedNgn > 0
          ? suggestedFareNgn
          : undefined,
      referralCashbackAppliedNgn:
        referralCashbackAppliedNgn > 0 ? referralCashbackAppliedNgn : undefined,
      route: plannedRoute.geometry,
      timestamp,
    });

    try {
      await publisher.publishRideEvent(event);
    } catch (error) {
      if (referralCashbackAppliedNgn > 0) {
        await referralClient.releaseRideCashback(rideId).catch((releaseError) => {
          console.warn('[referrals] cashback release after publish failure failed', {
            rideId,
            error:
              releaseError instanceof Error
                ? releaseError.message
                : String(releaseError),
          });
        });
      }
      throw error;
    }

    return {
      type: 'ride:request:accepted',
      payload: {
        rideId: event.rideId,
        status: 'bidding',
        pickup,
        destination,
        stops,
        route: plannedRoute.geometry,
        plannedDistanceKm: event.plannedDistanceKm,
        plannedDurationSeconds: event.plannedDurationSeconds,
        paymentMethod,
        riderOfferNgn,
        suggestedFareNgn,
        minOfferNgn,
        ratePerKmNgn,
        fareEstimateNgn: event.fareEstimateNgn,
        fareBeforeCashbackNgn: event.fareBeforeCashbackNgn,
        referralCashbackAppliedNgn,
        pricingCurrency: 'NGN',
      },
    };
  }

  if (type === 'ride:counter_offer') {
    const event = RideCounterOfferEvent.parse({
      eventType: 'RIDE_COUNTER_OFFER',
      rideId: requireString(payload, 'rideId'),
      riderId: requireString(payload, 'riderId'),
      driverId: getString(payload, 'driverId') ?? auth.driverId ?? auth.userId,
      driverUserId: auth.userId,
      counterOfferNgn: requireNumber(payload, 'counterOfferNgn'),
      driverName: requireString(payload, 'driverName'),
      driverRating: requireNumber(payload, 'driverRating'),
      vehiclePlate: requireString(payload, 'vehiclePlate'),
      vehicleModel: requireString(payload, 'vehicleModel'),
      etaSeconds: requireNumber(payload, 'etaSeconds'),
      timestamp,
    });

    await assertOfferMeetsMinimum(event.rideId, event.counterOfferNgn, 'driver');

    await publisher.publishRideEvent(event);

    return {
      type: 'ride:counter_offer:accepted',
      payload: {
        rideId: event.rideId,
        counterOfferNgn: event.counterOfferNgn,
      },
    };
  }

  if (type === 'ride:accept_offer') {
    const event = RideOfferAcceptedEvent.parse({
      eventType: 'RIDE_OFFER_ACCEPTED',
      rideId: requireString(payload, 'rideId'),
      riderId: auth.userId,
      driverId: requireString(payload, 'driverId'),
      driverUserId: requireString(payload, 'driverUserId'),
      agreedFareNgn: requireNumber(payload, 'agreedFareNgn'),
      paymentMethod: parsePaymentMethod(payload['paymentMethod']),
      timestamp,
    });

    await publisher.publishRideEvent(event);

    return {
      type: 'ride:accept_offer:accepted',
      payload: {
        rideId: event.rideId,
        driverId: event.driverId,
        agreedFareNgn: event.agreedFareNgn,
      },
    };
  }

  if (type === 'ride:rider_counter_offer') {
    const event = RideRiderCounterOfferEvent.parse({
      eventType: 'RIDE_RIDER_COUNTER_OFFER',
      rideId: requireString(payload, 'rideId'),
      riderId: auth.userId,
      driverId: requireString(payload, 'driverId'),
      counterOfferNgn: requireNumber(payload, 'counterOfferNgn'),
      timestamp,
    });

    await assertOfferMeetsMinimum(event.rideId, event.counterOfferNgn, 'rider');

    await publisher.publishRideEvent(event);

    return {
      type: 'ride:rider_counter_offer:accepted',
      payload: {
        rideId: event.rideId,
        driverId: event.driverId,
        counterOfferNgn: event.counterOfferNgn,
      },
    };
  }

  if (type === 'ride:route:update') {
    const riderId = getString(payload, 'riderId') ?? auth.userId;
    const origin = getRecord(payload, 'origin') ? parseLatLng(payload, 'origin') : undefined;
    const destination = parseLatLng(payload, 'destination');
    const stops = parseStopList(payload, 'stops');
    const plannedRoute = origin
      ? await routePlanner.planRoute({
          origin,
          stops,
          destination,
        })
      : null;
    const event = RideRouteUpdateRequestedEvent.parse({
      eventType: 'RIDE_ROUTE_UPDATE_REQUESTED',
      rideId: requireString(payload, 'rideId'),
      riderId,
      driverId: getString(payload, 'driverId'),
      destination,
      stops,
      plannedDistanceKm: plannedRoute?.distanceKm,
      plannedDurationSeconds: plannedRoute?.durationSeconds,
      fareEstimateNgn: plannedRoute?.suggestedFareNgn,
      route: plannedRoute?.geometry,
      updatedBy: auth.driverId ? 'driver' : 'rider',
      timestamp,
    });

    await publisher.publishRideEvent(event);
    return {
      type: 'ride:route:update:accepted',
      payload: {
        rideId: event.rideId,
        destination,
        stops,
        route: plannedRoute?.geometry,
        plannedDistanceKm: event.plannedDistanceKm,
        plannedDurationSeconds: event.plannedDurationSeconds,
        ...buildRideEstimatePricing(event.plannedDistanceKm),
      },
    };
  }

  if (type === 'ride:stop:confirm') {
    const driverId = getString(payload, 'driverId') ?? auth.driverId ?? auth.userId;
    const event = RideStopConfirmedEvent.parse({
      eventType: 'RIDE_STOP_CONFIRMED',
      rideId: requireString(payload, 'rideId'),
      riderId: requireString(payload, 'riderId'),
      driverId,
      confirmedBy: auth.driverId ? 'driver' : 'rider',
      timestamp,
    });

    await publisher.publishRideEvent(event);

    return {
      type: 'ride:stop:confirm:accepted',
      payload: { rideId: event.rideId },
    };
  }

  if (type === 'ride:cancel') {
    const rideId = requireString(payload, 'rideId');
    const cancelledBy: 'rider' | 'driver' = auth.driverId ? 'driver' : 'rider';

    // riderId must be the RIDER, not whoever sent the message. This was
    // auth.userId, so a driver-initiated cancel published the driver's own id
    // as riderId — the gateway then sent "ride cancelled" back to the driver
    // and the rider, the one person who needed to know, was never told.
    const ride = await rideClient.findById(rideId).catch(() => null);
    const riderId = ride?.riderId ?? (cancelledBy === 'rider' ? auth.userId : undefined);
    if (!riderId) {
      throw new Error('Could not resolve the rider for this ride.');
    }

    const event = RideCancelledEvent.parse({
      eventType: 'RIDE_CANCELLED',
      rideId,
      riderId,
      driverId: getString(payload, 'driverId') ?? ride?.driverId ?? auth.driverId,
      reason: getString(payload, 'reason'),
      cancelledBy,
      driverUserId: cancelledBy === 'driver' ? auth.userId : undefined,
      timestamp,
    });

    await publisher.publishRideEvent(event);

    return {
      type: 'ride:cancel:accepted',
      payload: { rideId: event.rideId },
    };
  }

  if (type === 'ride:start') {
    const driverId = getString(payload, 'driverId') ?? auth.driverId;
    if (!driverId) throw new Error('Missing required field: driverId');

    const event = RideStartedEvent.parse({
      eventType: 'RIDE_STARTED',
      rideId: requireString(payload, 'rideId'),
      riderId: requireString(payload, 'riderId'),
      driverId,
      lockedFareNgn: requireNumber(payload, 'lockedFareNgn'),
      paymentMethod: parsePaymentMethod(payload['paymentMethod']),
      startedAt: getString(payload, 'startedAt') ?? timestamp,
      timestamp,
    });

    await publisher.publishRideEvent(event);

    return {
      type: 'ride:start:accepted',
      payload: { rideId: event.rideId },
    };
  }

  if (type === 'ride:end') {
    const endDriverId = getString(payload, 'driverId') ?? auth.driverId;
    if (!endDriverId) throw new Error('Missing required field: driverId');

    const event = RideCompletionRequestedEvent.parse({
      eventType: 'RIDE_COMPLETION_REQUESTED',
      rideId: requireString(payload, 'rideId'),
      riderId: requireString(payload, 'riderId'),
      driverId: endDriverId,
      fareNgn: getNumber(payload, 'fareNgn'),
      endedBy: normalizeEndedBy(payload['endedBy']),
      completedAt: getString(payload, 'completedAt'),
      timestamp,
    });

    await publisher.publishRideEvent(event);

    return {
      type: 'ride:end:accepted',
      payload: { rideId: event.rideId },
    };
  }

  if (type === 'ride:arrived') {
    return {
      type: 'ride:arrived:ack',
      payload: {
        rideId: requireString(payload, 'rideId'),
      },
    };
  }

  if (type === 'driver:accept') {
    // Driver accepts / bids — look up real driver profile from DB
    const driverId = getString(payload, 'driverId') ?? auth.driverId ?? auth.userId;

    let driverName = getString(payload, 'driverName') ?? 'Driver';
    let driverRating = getNumber(payload, 'driverRating') ?? 5.0;
    let vehiclePlate = getString(payload, 'vehiclePlate') ?? '';
    let vehicleModel = getString(payload, 'vehicleModel') ?? '';

    try {
      const driver = await driverClient.findByUserId(auth.userId);
      if (driver) {
        driverName = driver.user.name ?? driver.user.phone ?? driverName;
        driverRating = driver.rating ?? driverRating;
        vehiclePlate = driver.vehiclePlate ?? vehiclePlate;
        vehicleModel = driver.vehicleModel ?? vehicleModel;
      }
    } catch {
      // Use client-provided fallbacks
    }

    const counterOfferEvent = RideCounterOfferEvent.parse({
      eventType: 'RIDE_COUNTER_OFFER',
      rideId: requireString(payload, 'rideId'),
      riderId: requireString(payload, 'riderId'),
      driverId,
      driverUserId: auth.userId,
      counterOfferNgn: requireNumber(payload, 'agreedFareNgn'),
      driverName,
      driverRating,
      vehiclePlate,
      vehicleModel,
      etaSeconds: requireNumber(payload, 'etaSeconds'),
      timestamp,
    });

    await publisher.publishRideEvent(counterOfferEvent);

    return {
      type: 'driver:accept:accepted',
      payload: {
        rideId: counterOfferEvent.rideId,
        riderId: counterOfferEvent.riderId,
      },
    };
  }

  if (type === 'driver:reject') {
    const event = RideDriverRejectedEvent.parse({
      eventType: 'RIDE_DRIVER_REJECTED',
      rideId: requireString(payload, 'rideId'),
      riderId: requireString(payload, 'riderId'),
      driverId: getString(payload, 'driverId') ?? auth.driverId ?? auth.userId,
      reason: getString(payload, 'reason') === 'manual_reject' ? 'manual_reject' : 'timeout',
      timestamp,
    });

    await publisher.publishRideEvent(event);

    return {
      type: 'driver:reject:accepted',
      payload: {
        rideId: event.rideId,
      },
    };
  }

  if (type === 'feedback:submit') {
    const event = FeedbackLoggedEvent.parse({
      eventType: 'FEEDBACK_LOGGED',
      feedbackId: getString(payload, 'feedbackId') ?? randomUUID(),
      rideId: requireString(payload, 'rideId'),
      reviewerId: auth.userId,
      reviewerRole: normalizeReviewerRole(payload['reviewerRole']),
      revieweeId: requireString(payload, 'revieweeId'),
      rating: requireNumber(payload, 'rating'),
      comment: getString(payload, 'comment'),
      timestamp,
    });

    await publisher.publishComplianceEvent(event);

    return {
      type: 'feedback:submit:accepted',
      payload: {
        feedbackId: event.feedbackId,
        rideId: event.rideId,
      },
    };
  }

  if (type === 'chat:send') {
    const rideId = requireString(payload, 'rideId');
    const content = requireString(payload, 'content');
    if (content.length > 1000) throw new Error('Message too long (max 1000 chars).');

    const senderRole = auth.driverId ? 'DRIVER' : 'RIDER';
    const message = await chatClient.create({
      rideId,
      senderId: auth.userId,
      senderRole: senderRole as 'RIDER' | 'DRIVER',
      content,
    });

    const event = ChatMessageSentEvent.parse({
      eventType: 'CHAT_MESSAGE_SENT',
      rideId,
      messageId: message.id,
      senderId: auth.userId,
      senderRole,
      content,
      timestamp,
    });

    await publisher.publishRideEvent(event);

    return {
      type: 'chat:send:accepted',
      payload: {
        messageId: message.id,
        rideId,
      },
    };
  }

  if (type === 'dispute:open') {
    const event = DisputeOpenedEvent.parse({
      eventType: 'DISPUTE_OPENED',
      disputeId: getString(payload, 'disputeId') ?? randomUUID(),
      rideId: requireString(payload, 'rideId'),
      openedBy: auth.userId,
      openedByRole: normalizeOpenedByRole(payload['openedByRole']),
      againstId: requireString(payload, 'againstId'),
      reason: requireString(payload, 'reason'),
      timestamp,
    });

    await publisher.publishComplianceEvent(event);

    return {
      type: 'dispute:open:accepted',
      payload: {
        disputeId: event.disputeId,
        rideId: event.rideId,
      },
    };
  }

  return null;
}
