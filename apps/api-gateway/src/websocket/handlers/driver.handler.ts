import {
  DriverOfflineEvent,
  DriverOnlineEvent,
  GpsUpdateEvent,
} from '@wheleers/kafka-schemas';
import type { GatewayAuthContext } from '../../types';
import { getNumber, getString } from '../../utils/object';
import type { GatewayPublisher } from '../publisher';
import type { HandlerResponse } from './types';

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

function resolveDriverId(payload: Record<string, unknown>, auth: GatewayAuthContext): string {
  const fromPayload = getString(payload, 'driverId');
  if (fromPayload) return fromPayload;

  if (auth.driverId) return auth.driverId;

  if (auth.role === 'DRIVER' || auth.role === 'BOTH') {
    return auth.userId;
  }

  throw new Error('driverId is required for driver events');
}

export async function handleDriverMessage(
  type: string,
  payload: Record<string, unknown>,
  auth: GatewayAuthContext,
  publisher: GatewayPublisher,
): Promise<HandlerResponse | null> {
  const timestamp = new Date().toISOString();

  if (type === 'driver:online') {
    const event = DriverOnlineEvent.parse({
      eventType: 'DRIVER_ONLINE',
      driverId: resolveDriverId(payload, auth),
      walletAddress: (getString(payload, 'walletAddress') ?? auth.walletAddress).toLowerCase(),
      lat: requireNumber(payload, 'lat'),
      lng: requireNumber(payload, 'lng'),
      vehiclePlate: getString(payload, 'vehiclePlate') ?? 'UNKNOWN',
      vehicleModel: getString(payload, 'vehicleModel') ?? 'UNKNOWN',
      timestamp,
    });

    await publisher.publishDriverEvent(event);

    return {
      type: 'driver:online:accepted',
      payload: {
        driverId: event.driverId,
      },
    };
  }

  if (type === 'driver:offline') {
    const event = DriverOfflineEvent.parse({
      eventType: 'DRIVER_OFFLINE',
      driverId: resolveDriverId(payload, auth),
      reason: getString(payload, 'reason') === 'app_closed'
        ? 'app_closed'
        : getString(payload, 'reason') === 'inactivity'
          ? 'inactivity'
          : getString(payload, 'reason') === 'admin'
            ? 'admin'
            : 'manual',
      timestamp,
    });

    await publisher.publishDriverEvent(event);

    return {
      type: 'driver:offline:accepted',
      payload: {
        driverId: event.driverId,
      },
    };
  }

  if (type === 'driver:gps') {
    const event = GpsUpdateEvent.parse({
      eventType: 'GPS_UPDATE',
      rideId: requireString(payload, 'rideId'),
      driverId: resolveDriverId(payload, auth),
      lat: requireNumber(payload, 'lat'),
      lng: requireNumber(payload, 'lng'),
      speedKmh: getNumber(payload, 'speedKmh'),
      headingDeg: getNumber(payload, 'headingDeg'),
      accuracyM: getNumber(payload, 'accuracyM'),
      timestamp,
    });

    await publisher.publishGpsEvent(event);

    return {
      type: 'driver:gps:accepted',
      payload: {
        rideId: event.rideId,
      },
    };
  }

  return null;
}
