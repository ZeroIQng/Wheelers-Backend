import type { WheelersProducer } from '@wheleers/kafka-client';
import {
  TOPICS,
  type GpsStaleWarningEvent,
  type InAppSendEvent,
  type PushSendEvent,
  type RideCancelledEvent,
  type RideCompletedEvent,
  type RideDriverAssignedEvent,
  type RideDriverRejectedEvent,
  type RideRouteUpdatedEvent,
  type RideRequestedEvent,
} from '@wheleers/kafka-schemas';
import { randomUUID } from 'node:crypto';

import type { OnlineDriver } from '../index';

export type RideEventsProducer = {
  rideRequested(event: RideRequestedEvent): Promise<void>;
  rideDriverAssigned(event: RideDriverAssignedEvent): Promise<void>;
  rideDriverRejected(event: RideDriverRejectedEvent): Promise<void>;
  rideCancelled(event: RideCancelledEvent): Promise<void>;
  rideCompleted(event: RideCompletedEvent): Promise<void>;
  rideRouteUpdated(event: RideRouteUpdatedEvent): Promise<void>;
  rideOfferNotification(params: {
    driver: OnlineDriver;
    rideRequested: RideRequestedEvent;
    expiresAt: Date;
  }): Promise<void>;
  gpsStaleWarning(event: GpsStaleWarningEvent): Promise<void>;
};

export function createRideEventsProducer(producer: WheelersProducer): RideEventsProducer {
  return {
    async rideRequested(event) {
      await producer.send(TOPICS.RIDE_EVENTS, event as any, { key: event.rideId });
    },

    async rideDriverAssigned(event) {
      await producer.send(TOPICS.RIDE_EVENTS, event as any, { key: event.rideId });
    },

    async rideDriverRejected(event) {
      await producer.send(TOPICS.RIDE_EVENTS, event as any, { key: event.rideId });
    },

    async rideCancelled(event) {
      await producer.send(TOPICS.RIDE_EVENTS, event as any, { key: event.rideId });
    },

    async rideCompleted(event) {
      await producer.send(TOPICS.RIDE_EVENTS, event as any, { key: event.rideId });
    },

    async rideRouteUpdated(event) {
      await producer.send(TOPICS.RIDE_EVENTS, event as any, { key: event.rideId });
    },

    async rideOfferNotification({ driver, rideRequested, expiresAt }) {
      const timestamp = new Date().toISOString();
      const title = 'New ride request';
      const stopCount = rideRequested.stops.length;
      const body =
        stopCount > 0
          ? `${rideRequested.pickup.address} to ${rideRequested.destination.address} with ${stopCount} stop${stopCount === 1 ? '' : 's'}`
          : `${rideRequested.pickup.address} to ${rideRequested.destination.address}`;

      const push: PushSendEvent = {
        eventType: 'PUSH_SEND',
        notificationId: randomUUID(),
        userId: driver.driverId,
        title,
        body,
        data: {
          type: 'ride:request',
          rideId: rideRequested.rideId,
          riderId: rideRequested.riderId,
          pickupLat: String(rideRequested.pickup.lat),
          pickupLng: String(rideRequested.pickup.lng),
          pickupAddress: rideRequested.pickup.address,
          destinationLat: String(rideRequested.destination.lat),
          destinationLng: String(rideRequested.destination.lng),
          destinationAddress: rideRequested.destination.address,
          stops: JSON.stringify(rideRequested.stops),
          stopCount: String(stopCount),
          plannedDistanceKm:
            rideRequested.plannedDistanceKm === undefined ? '' : String(rideRequested.plannedDistanceKm),
          plannedDurationSeconds:
            rideRequested.plannedDurationSeconds === undefined
              ? ''
              : String(rideRequested.plannedDurationSeconds),
          fareEstimateNgn: String(rideRequested.fareEstimateNgn),
          expiresAt: expiresAt.toISOString(),
        },
        priority: 'high',
        timestamp,
      };

      const inApp: InAppSendEvent = {
        eventType: 'IN_APP_SEND',
        notificationId: randomUUID(),
        userId: driver.driverId,
        title,
        body,
        category: 'ride',
        referenceId: rideRequested.rideId,
        referenceType: 'ride',
        read: false,
        timestamp,
      };

      await producer.sendBatch([
        { topic: TOPICS.NOTIFICATION_EVENTS, value: push as any, options: { key: driver.driverId } },
        { topic: TOPICS.NOTIFICATION_EVENTS, value: inApp as any, options: { key: driver.driverId } },
      ]);
    },

    async gpsStaleWarning(event) {
      await producer.send(TOPICS.COMPLIANCE_EVENTS, event as any, { key: event.rideId });
    },
  };
}
