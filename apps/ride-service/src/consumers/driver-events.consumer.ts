import { driverClient } from '@wheleers/db';
import { safeParseKafkaEvent, TOPICS, type DriverOnlineEvent, type DriverOfflineEvent } from '@wheleers/kafka-schemas';
import type { MessageContext } from '@wheleers/kafka-client';

import type { RideServiceState } from '../index';

export function createDriverEventsConsumer(params: {
  state: RideServiceState;
  onDriverOnline?: (event: DriverOnlineEvent) => Promise<void>;
  onDriverOffline?: (event: DriverOfflineEvent) => Promise<void>;
}): { handle: (value: unknown, ctx: MessageContext) => Promise<void> } {
  const { state, onDriverOnline, onDriverOffline } = params;

  return {
    async handle(value, ctx) {
      if (ctx.topic !== TOPICS.DRIVER_EVENTS) return;
      const event = safeParseKafkaEvent(TOPICS.DRIVER_EVENTS, value);
      if (!event) return;

      if (event.eventType === 'DRIVER_ONLINE') {
        state.onlineDrivers.set(event.driverId, {
          driverId: event.driverId,
          walletAddress: event.walletAddress,
          lat: event.lat,
          lng: event.lng,
          vehiclePlate: event.vehiclePlate,
          vehicleModel: event.vehicleModel,
        });
        try {
          await driverClient.markOnline(event.driverId, event.lat, event.lng);
        } catch (err) {
          console.warn(`[ride-service] driver online persistence skipped:`, (err as any)?.message ?? err);
        }
        if (onDriverOnline) await onDriverOnline(event);
      }

      if (event.eventType === 'DRIVER_OFFLINE') {
        state.onlineDrivers.delete(event.driverId);
        for (const [rideId, driver] of state.assignedDriversByRideId) {
          if (driver.driverId === event.driverId) {
            state.assignedDriversByRideId.delete(rideId);
          }
        }
        try {
          await driverClient.markOffline(event.driverId);
        } catch (err) {
          console.warn(`[ride-service] driver offline persistence skipped:`, (err as any)?.message ?? err);
        }
        if (onDriverOffline) await onDriverOffline(event);
      }
    },
  };
}
