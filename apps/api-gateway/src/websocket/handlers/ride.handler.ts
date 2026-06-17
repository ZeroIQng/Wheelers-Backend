import { randomUUID } from 'crypto';
import { GoogleMapsRoutePlanner } from '@wheleers/config';
import { chatClient, referralClient } from '@wheleers/db';
import {
  ChatMessageSentEvent,
  DisputeOpenedEvent,
  FeedbackLoggedEvent,
  RideCancelledEvent,
  RideCompletionRequestedEvent,
  RideDriverAssignedEvent,
  RideDriverRejectedEvent,
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
    const plannedRoute = await routePlanner.planRoute({
      origin: pickup,
      stops,
      destination,
    });
    const useReferralCashback =
      getBoolean(payload, 'useReferralCashback') ?? false;
    const requestedReferralCashbackNgn = getNumber(
      payload,
      'requestedReferralCashbackNgn',
    );
    let referralCashbackAppliedNgn = 0;
    let fareEstimateNgn = plannedRoute.fareEstimateNgn;

    if (useReferralCashback) {
      const reservation = await referralClient.reserveRideCashback({
        userId: auth.userId,
        rideId,
        fareNgn: plannedRoute.ridePrice.tripPrice,
        requestedAmountNgn: requestedReferralCashbackNgn,
      });
      referralCashbackAppliedNgn = reservation.reservedCashbackNgn;
      fareEstimateNgn = Math.max(
        0,
        plannedRoute.fareEstimateNgn - referralCashbackAppliedNgn,
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
      fareBeforeCashbackNgn:
        referralCashbackAppliedNgn > 0
          ? plannedRoute.fareEstimateNgn
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
        status: 'queued',
        pickup,
        destination,
        stops,
        route: plannedRoute.geometry,
        plannedDistanceKm: event.plannedDistanceKm,
        plannedDurationSeconds: event.plannedDurationSeconds,
        fareEstimateNgn: event.fareEstimateNgn,
        fareBeforeCashbackNgn: event.fareBeforeCashbackNgn,
        referralCashbackAppliedNgn,
        pricingCurrency: 'NGN',
        pricingBreakdown: {
          ...plannedRoute.ridePrice,
          tripPrice: fareEstimateNgn,
          originalTripPrice: plannedRoute.ridePrice.tripPrice,
          referralCashbackAppliedNgn,
        },
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
      fareEstimateNgn: plannedRoute?.fareEstimateNgn,
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
    const event = RideCancelledEvent.parse({
      eventType: 'RIDE_CANCELLED',
      rideId: requireString(payload, 'rideId'),
      riderId: auth.userId,
      driverId: getString(payload, 'driverId'),
      reason: getString(payload, 'reason'),
      timestamp,
    });

    await publisher.publishRideEvent(event);

    return {
      type: 'ride:cancel:accepted',
      payload: { rideId: event.rideId },
    };
  }

  if (type === 'ride:start') {
    const event = RideStartedEvent.parse({
      eventType: 'RIDE_STARTED',
      rideId: requireString(payload, 'rideId'),
      riderId: requireString(payload, 'riderId'),
      driverId: requireString(payload, 'driverId'),
      lockedFareNgn: requireNumber(payload, 'lockedFareNgn'),
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
    const event = RideCompletionRequestedEvent.parse({
      eventType: 'RIDE_COMPLETION_REQUESTED',
      rideId: requireString(payload, 'rideId'),
      riderId: requireString(payload, 'riderId'),
      driverId: requireString(payload, 'driverId'),
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
    const event = RideDriverAssignedEvent.parse({
      eventType: 'RIDE_DRIVER_ASSIGNED',
      rideId: requireString(payload, 'rideId'),
      riderId: requireString(payload, 'riderId'),
      driverId: getString(payload, 'driverId') ?? auth.driverId ?? auth.userId,
      driverUserId: auth.userId,
      driverName: requireString(payload, 'driverName'),
      driverRating: requireNumber(payload, 'driverRating'),
      vehiclePlate: requireString(payload, 'vehiclePlate'),
      vehicleModel: requireString(payload, 'vehicleModel'),
      etaSeconds: requireNumber(payload, 'etaSeconds'),
      lockedFareNgn: requireNumber(payload, 'lockedFareNgn'),
      timestamp,
    });

    await publisher.publishRideEvent(event);

    return {
      type: 'driver:accept:accepted',
      payload: {
        rideId: event.rideId,
        riderId: event.riderId,
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
