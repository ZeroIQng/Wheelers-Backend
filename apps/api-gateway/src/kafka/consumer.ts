import type { WheelersConsumer } from '@wheleers/kafka-client';
import {
  ComplianceEvent,
  GpsProcessedEvent,
  NotificationEvent,
  RideEvent,
  TOPICS,
  WalletEvent,
} from '@wheleers/kafka-schemas';
import { SocketRegistry } from '../websocket/registry';

interface StartGatewayConsumerDeps {
  consumer: WheelersConsumer;
  registry: SocketRegistry;
}

interface RideParticipantState {
  riderId: string;
  driverId?: string;
}

export async function startGatewayKafkaConsumer(deps: StartGatewayConsumerDeps): Promise<void> {
  const rideParticipants = new Map<string, RideParticipantState>();

  await deps.consumer.subscribe(
    [
      TOPICS.RIDE_EVENTS,
      TOPICS.WALLET_EVENTS,
      TOPICS.NOTIFICATION_EVENTS,
      TOPICS.GPS_PROCESSED,
      TOPICS.COMPLIANCE_EVENTS,
    ],
    async (value, context) => {
      if (context.topic === TOPICS.RIDE_EVENTS) {
        const parsed = RideEvent.safeParse(value);
        if (!parsed.success) {
          throw new Error(`Invalid ride event: ${parsed.error.message}`);
        }
        handleRideEvent(parsed.data, deps.registry, rideParticipants);
        return;
      }

      if (context.topic === TOPICS.WALLET_EVENTS) {
        const parsed = WalletEvent.safeParse(value);
        if (!parsed.success) {
          throw new Error(`Invalid wallet event: ${parsed.error.message}`);
        }
        handleWalletEvent(parsed.data, deps.registry);
        return;
      }

      if (context.topic === TOPICS.NOTIFICATION_EVENTS) {
        const parsed = NotificationEvent.safeParse(value);
        if (!parsed.success) {
          throw new Error(`Invalid notification event: ${parsed.error.message}`);
        }
        handleNotificationEvent(parsed.data, deps.registry);
        return;
      }

      if (context.topic === TOPICS.GPS_PROCESSED) {
        const parsed = GpsProcessedEvent.safeParse(value);
        if (!parsed.success) {
          throw new Error(`Invalid GPS processed event: ${parsed.error.message}`);
        }
        handleGpsProcessedEvent(parsed.data, deps.registry, rideParticipants);
        return;
      }

      if (context.topic === TOPICS.COMPLIANCE_EVENTS) {
        const parsed = ComplianceEvent.safeParse(value);
        if (!parsed.success) {
          throw new Error(`Invalid compliance event: ${parsed.error.message}`);
        }
        handleComplianceEvent(parsed.data, deps.registry);
      }
    },
  );
}

function handleRideEvent(
  event: RideEvent,
  registry: SocketRegistry,
  rideParticipants: Map<string, RideParticipantState>,
): void {
  if (event.eventType === 'RIDE_REQUESTED') {
    rideParticipants.set(event.rideId, { riderId: event.riderId });
    return;
  }

  if (event.eventType === 'RIDE_DRIVER_ASSIGNED') {
    rideParticipants.set(event.rideId, {
      riderId: event.riderId,
      driverId: event.driverId,
    });

    registry.sendToUser(event.riderId, 'ride:matched', {
      rideId: event.rideId,
      driverId: event.driverId,
      driverName: event.driverName,
      driverRating: event.driverRating,
      vehiclePlate: event.vehiclePlate,
      vehicleModel: event.vehicleModel,
      etaSeconds: event.etaSeconds,
      lockedFareUsdt: event.lockedFareUsdt,
    });

    return;
  }

  if (event.eventType === 'RIDE_STARTED') {
    rideParticipants.set(event.rideId, {
      riderId: event.riderId,
      driverId: event.driverId,
    });

    registry.sendToUser(event.riderId, 'ride:started', {
      rideId: event.rideId,
      startedAt: event.startedAt,
    });

    registry.sendToUser(event.driverId, 'ride:started', {
      rideId: event.rideId,
      startedAt: event.startedAt,
    });

    return;
  }

  if (event.eventType === 'RIDE_COMPLETED') {
    registry.sendToUser(event.riderId, 'ride:completed', {
      rideId: event.rideId,
      fareUsdt: event.fareUsdt,
      distanceKm: event.distanceKm,
      durationSeconds: event.durationSeconds,
      completedAt: event.completedAt,
    });

    registry.sendToUser(event.driverId, 'ride:completed', {
      rideId: event.rideId,
      fareUsdt: event.fareUsdt,
      distanceKm: event.distanceKm,
      durationSeconds: event.durationSeconds,
      completedAt: event.completedAt,
    });

    rideParticipants.delete(event.rideId);
    return;
  }

  if (event.eventType === 'RIDE_CANCELLED') {
    registry.sendToUser(event.riderId, 'ride:cancelled', {
      rideId: event.rideId,
      reason: event.reason,
      cancelStage: event.cancelStage,
      penaltyUsdt: event.penaltyUsdt,
    });

    if (event.driverId) {
      registry.sendToUser(event.driverId, 'ride:cancelled', {
        rideId: event.rideId,
        reason: event.reason,
        cancelStage: event.cancelStage,
      });
    }

    rideParticipants.delete(event.rideId);
    return;
  }

  if (event.eventType === 'RIDE_DRIVER_REJECTED') {
    registry.sendToUser(event.riderId, 'ride:driver_rejected', {
      rideId: event.rideId,
      reason: event.reason,
    });
  }
}

function handleWalletEvent(event: WalletEvent, registry: SocketRegistry): void {
  if (event.eventType === 'WALLET_CREDITED') {
    registry.sendToUser(event.userId, 'wallet:updated', {
      walletId: event.walletId,
      balanceUsdt: event.newBalanceUsdt,
      changeUsdt: event.amountUsdt,
      changeType: event.creditType,
      direction: 'credit',
      referenceId: event.referenceId,
    });
    return;
  }

  if (event.eventType === 'WALLET_DEBITED') {
    registry.sendToUser(event.userId, 'wallet:updated', {
      walletId: event.walletId,
      balanceUsdt: event.newBalanceUsdt,
      changeUsdt: event.amountUsdt,
      changeType: event.debitType,
      direction: 'debit',
      referenceId: event.referenceId,
    });
    return;
  }

  if (event.eventType === 'WALLET_LOCKED') {
    registry.sendToUser(event.userId, 'wallet:updated', {
      walletId: event.walletId,
      rideId: event.rideId,
      lockedAmountUsdt: event.lockedAmountUsdt,
      reason: event.reason,
      direction: 'lock',
    });
    return;
  }

  registry.sendToUser(event.userId, 'wallet:updated', {
    walletId: event.walletId,
    rideId: event.rideId,
    unlockedAmountUsdt: event.unlockedAmountUsdt,
    reason: event.reason,
    direction: 'unlock',
  });
}

function handleNotificationEvent(event: NotificationEvent, registry: SocketRegistry): void {
  if (event.eventType !== 'IN_APP_SEND') return;

  registry.sendToUser(event.userId, 'notification:new', {
    notificationId: event.notificationId,
    title: event.title,
    body: event.body,
    category: event.category,
    referenceId: event.referenceId,
    referenceType: event.referenceType,
    read: event.read,
  });
}

function handleGpsProcessedEvent(
  event: GpsProcessedEvent,
  registry: SocketRegistry,
  rideParticipants: Map<string, RideParticipantState>,
): void {
  const participants = rideParticipants.get(event.rideId);
  if (!participants?.riderId) {
    return;
  }

  registry.sendToUser(participants.riderId, 'ride:driver_location', {
    rideId: event.rideId,
    lat: event.lat,
    lng: event.lng,
    heading: event.headingDeg,
    speedKmh: event.speedKmh,
    distanceFromLastKm: event.distanceFromLastKm,
    totalDistanceKm: event.totalDistanceKm,
    isStale: event.isStale,
  });
}

function handleComplianceEvent(event: ComplianceEvent, registry: SocketRegistry): void {
  if (event.eventType !== 'GPS_STALE_WARNING') return;

  registry.sendToUser(event.riderId, 'gps:stale_warning', {
    rideId: event.rideId,
    staleMinutes: event.staleMinutes,
    lastKnownLat: event.lastKnownLat,
    lastKnownLng: event.lastKnownLng,
  });
}
