import { randomUUID } from 'crypto';
import {
  DisputeOpenedEvent,
  FeedbackLoggedEvent,
  RideCancelledEvent,
  RideCompletedEvent,
  RideDriverAssignedEvent,
  RideDriverRejectedEvent,
  RideRequestedEvent,
  RideStartedEvent,
} from '@wheleers/kafka-schemas';
import type { GatewayAuthContext } from '../../types';
import { getBoolean, getNumber, getRecord, getString } from '../../utils/object';
import type { GatewayPublisher } from '../publisher';
import type { HandlerResponse } from './types';

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

function requireAuthWalletAddress(
  payload: Record<string, unknown>,
  auth: GatewayAuthContext,
  key: 'riderWallet' | 'driverWallet',
): string {
  const walletAddress = getString(payload, key) ?? auth.walletAddress;
  if (!walletAddress) {
    throw new Error(`${key} is required`);
  }

  return walletAddress.toLowerCase();
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

function normalizePaymentMethod(value: unknown): 'wallet_balance' | 'smart_account' {
  return value === 'smart_account' ? 'smart_account' : 'wallet_balance';
}

function normalizeCancelStage(value: unknown): 'before_match' | 'after_match' | 'driver_en_route' | 'active_trip' {
  if (value === 'after_match' || value === 'driver_en_route' || value === 'active_trip') {
    return value;
  }
  return 'before_match';
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
): Promise<HandlerResponse | null> {
  const timestamp = new Date().toISOString();

  if (type === 'ride:request') {
    const rideId = getString(payload, 'rideId') ?? randomUUID();
    const pickup = parseLatLng(payload, 'pickup');
    const destination = parseLatLng(payload, 'destination');
    const fareEstimateUsdt =
      getNumber(payload, 'fareEstimateUsdt') ??
      getNumber(payload, 'fareEstimate') ??
      requireNumber(payload, 'fareEstimateUsdt');

    const event = RideRequestedEvent.parse({
      eventType: 'RIDE_REQUESTED',
      rideId,
      riderId: auth.userId,
      riderWallet: requireAuthWalletAddress(payload, auth, 'riderWallet'),
      pickup,
      destination,
      fareEstimateUsdt,
      paymentMethod: normalizePaymentMethod(payload['paymentMethod']),
      timestamp,
    });

    await publisher.publishRideEvent(event);

    return {
      type: 'ride:request:accepted',
      payload: {
        rideId: event.rideId,
        status: 'queued',
      },
    };
  }

  if (type === 'ride:cancel') {
    const event = RideCancelledEvent.parse({
      eventType: 'RIDE_CANCELLED',
      rideId: requireString(payload, 'rideId'),
      riderId: auth.userId,
      driverId: getString(payload, 'driverId'),
      riderWallet: requireAuthWalletAddress(payload, auth, 'riderWallet'),
      driverWallet: getString(payload, 'driverWallet')?.toLowerCase(),
      cancelStage: normalizeCancelStage(payload['cancelStage']),
      penaltyUsdt: getNumber(payload, 'penaltyUsdt') ?? 0,
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
      riderWallet: requireString(payload, 'riderWallet').toLowerCase(),
      driverWallet: requireString(payload, 'driverWallet').toLowerCase(),
      lockedFareUsdt: requireNumber(payload, 'lockedFareUsdt'),
      recordingConsentVerified: getBoolean(payload, 'recordingConsentVerified') ?? false,
      recordingId: getString(payload, 'recordingId'),
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
    const event = RideCompletedEvent.parse({
      eventType: 'RIDE_COMPLETED',
      rideId: requireString(payload, 'rideId'),
      riderId: requireString(payload, 'riderId'),
      driverId: requireString(payload, 'driverId'),
      riderWallet: requireString(payload, 'riderWallet').toLowerCase(),
      driverWallet: requireString(payload, 'driverWallet').toLowerCase(),
      fareUsdt: requireNumber(payload, 'fareUsdt'),
      distanceKm: requireNumber(payload, 'distanceKm'),
      durationSeconds: requireNumber(payload, 'durationSeconds'),
      recordingCid: getString(payload, 'recordingCid'),
      recordingHash: getString(payload, 'recordingHash'),
      endedBy: normalizeEndedBy(payload['endedBy']),
      completedAt: getString(payload, 'completedAt') ?? timestamp,
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
      driverWallet: requireString(payload, 'driverWallet').toLowerCase(),
      driverName: requireString(payload, 'driverName'),
      driverRating: requireNumber(payload, 'driverRating'),
      vehiclePlate: requireString(payload, 'vehiclePlate'),
      vehicleModel: requireString(payload, 'vehicleModel'),
      etaSeconds: requireNumber(payload, 'etaSeconds'),
      lockedFareUsdt: requireNumber(payload, 'lockedFareUsdt'),
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
      revieweeWallet: requireString(payload, 'revieweeWallet').toLowerCase(),
      rating: requireNumber(payload, 'rating'),
      comment: getString(payload, 'comment'),
      commentHash: getString(payload, 'commentHash'),
      onchainTxHash: getString(payload, 'onchainTxHash'),
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

  if (type === 'dispute:open') {
    const event = DisputeOpenedEvent.parse({
      eventType: 'DISPUTE_OPENED',
      disputeId: getString(payload, 'disputeId') ?? randomUUID(),
      rideId: requireString(payload, 'rideId'),
      openedBy: auth.userId,
      openedByRole: normalizeOpenedByRole(payload['openedByRole']),
      againstId: requireString(payload, 'againstId'),
      reason: requireString(payload, 'reason'),
      recordingCid: getString(payload, 'recordingCid'),
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
