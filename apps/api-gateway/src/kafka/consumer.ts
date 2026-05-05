import type { WheelersConsumer } from '@wheleers/kafka-client';
import {
  ComplianceEvent,
  GpsProcessedEvent,
  NotificationEvent,
  RideEvent,
  TOPICS,
  WalletEvent,
} from '@wheleers/kafka-schemas';
import {
  convertUsdtToRideDisplayAmount,
  type RidePricingDisplayProvider,
} from '../pricing/display';
import { buildRideEstimatePricing } from '../pricing/ride-estimate';
import { SocketRegistry } from '../websocket/registry';

interface StartGatewayConsumerDeps {
  consumer: WheelersConsumer;
  registry: SocketRegistry;
  ridePricingDisplayProvider: RidePricingDisplayProvider;
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
        await handleRideEvent(
          parsed.data,
          deps.registry,
          rideParticipants,
          deps.ridePricingDisplayProvider,
        );
        return;
      }

      if (context.topic === TOPICS.WALLET_EVENTS) {
        const parsed = WalletEvent.safeParse(value);
        if (!parsed.success) {
          throw new Error(`Invalid wallet event: ${parsed.error.message}`);
        }
        await handleWalletEvent(parsed.data, deps.registry);
        return;
      }

      if (context.topic === TOPICS.NOTIFICATION_EVENTS) {
        const parsed = NotificationEvent.safeParse(value);
        if (!parsed.success) {
          throw new Error(`Invalid notification event: ${parsed.error.message}`);
        }
        await handleNotificationEvent(parsed.data, deps.registry);
        return;
      }

      if (context.topic === TOPICS.GPS_PROCESSED) {
        const parsed = GpsProcessedEvent.safeParse(value);
        if (!parsed.success) {
          throw new Error(`Invalid GPS processed event: ${parsed.error.message}`);
        }
        await handleGpsProcessedEvent(parsed.data, deps.registry, rideParticipants);
        return;
      }

      if (context.topic === TOPICS.COMPLIANCE_EVENTS) {
        const parsed = ComplianceEvent.safeParse(value);
        if (!parsed.success) {
          throw new Error(`Invalid compliance event: ${parsed.error.message}`);
        }
        await handleComplianceEvent(parsed.data, deps.registry);
      }
    },
  );
}

async function handleRideEvent(
  event: RideEvent,
  registry: SocketRegistry,
  rideParticipants: Map<string, RideParticipantState>,
  ridePricingDisplayProvider: RidePricingDisplayProvider,
): Promise<void> {
  if (event.eventType === 'RIDE_REQUESTED') {
    rideParticipants.set(event.rideId, { riderId: event.riderId });
    return;
  }

  if (event.eventType === 'RIDE_DRIVER_ASSIGNED') {
    const ridePricingDisplay = await ridePricingDisplayProvider.getPricingDisplay();
    rideParticipants.set(event.rideId, {
      riderId: event.riderId,
      driverId: event.driverId,
    });

    await registry.sendToUser(event.riderId, 'ride:matched', {
      rideId: event.rideId,
      driverId: event.driverId,
      driverWallet: event.driverWallet,
      driverName: event.driverName,
      driverRating: event.driverRating,
      vehiclePlate: event.vehiclePlate,
      vehicleModel: event.vehicleModel,
      etaSeconds: event.etaSeconds,
      lockedFareUsdt: event.lockedFareUsdt,
      lockedFareNgn: convertUsdtToRideDisplayAmount(event.lockedFareUsdt, ridePricingDisplay),
      displayCurrency: ridePricingDisplay.displayCurrency,
      displayExchangeRate: ridePricingDisplay.displayExchangeRate,
    });

    return;
  }

  if (event.eventType === 'RIDE_ROUTE_UPDATED') {
    const routePayload = {
      rideId: event.rideId,
      destination: event.destination,
      stops: event.stops,
      route: event.route,
      plannedDistanceKm: event.plannedDistanceKm,
      plannedDurationSeconds: event.plannedDurationSeconds,
      fareEstimateUsdt: event.fareEstimateUsdt,
      ...buildRideEstimatePricing(event.plannedDistanceKm),
      updatedBy: event.updatedBy,
    };

    await registry.sendToUser(event.riderId, 'ride:route:updated', routePayload);

    if (event.driverId) {
      rideParticipants.set(event.rideId, {
        riderId: event.riderId,
        driverId: event.driverId,
      });
      await registry.sendToUser(event.driverId, 'ride:route:updated', routePayload);
    }

    return;
  }

  if (event.eventType === 'RIDE_STARTED') {
    rideParticipants.set(event.rideId, {
      riderId: event.riderId,
      driverId: event.driverId,
    });

    await registry.sendToUser(event.riderId, 'ride:started', {
      rideId: event.rideId,
      startedAt: event.startedAt,
    });

    await registry.sendToUser(event.driverId, 'ride:started', {
      rideId: event.rideId,
      startedAt: event.startedAt,
    });

    return;
  }

  if (event.eventType === 'RIDE_COMPLETED') {
    const ridePricingDisplay = await ridePricingDisplayProvider.getPricingDisplay();
    await registry.sendToUser(event.riderId, 'ride:completed', {
      rideId: event.rideId,
      fareUsdt: event.fareUsdt,
      fareNgn: convertUsdtToRideDisplayAmount(event.fareUsdt, ridePricingDisplay),
      distanceKm: event.distanceKm,
      durationSeconds: event.durationSeconds,
      completedAt: event.completedAt,
      displayCurrency: ridePricingDisplay.displayCurrency,
      displayExchangeRate: ridePricingDisplay.displayExchangeRate,
    });

    await registry.sendToUser(event.driverId, 'ride:completed', {
      rideId: event.rideId,
      fareUsdt: event.fareUsdt,
      fareNgn: convertUsdtToRideDisplayAmount(event.fareUsdt, ridePricingDisplay),
      distanceKm: event.distanceKm,
      durationSeconds: event.durationSeconds,
      completedAt: event.completedAt,
      displayCurrency: ridePricingDisplay.displayCurrency,
      displayExchangeRate: ridePricingDisplay.displayExchangeRate,
    });

    rideParticipants.delete(event.rideId);
    return;
  }

  if (event.eventType === 'RIDE_CANCELLED') {
    const ridePricingDisplay = await ridePricingDisplayProvider.getPricingDisplay();
    await registry.sendToUser(event.riderId, 'ride:cancelled', {
      rideId: event.rideId,
      reason: event.reason,
      cancelStage: event.cancelStage,
      penaltyUsdt: event.penaltyUsdt,
      penaltyNgn: convertUsdtToRideDisplayAmount(event.penaltyUsdt, ridePricingDisplay),
      displayCurrency: ridePricingDisplay.displayCurrency,
      displayExchangeRate: ridePricingDisplay.displayExchangeRate,
    });

    if (event.driverId) {
      await registry.sendToUser(event.driverId, 'ride:cancelled', {
        rideId: event.rideId,
        reason: event.reason,
        cancelStage: event.cancelStage,
      });
    }

    rideParticipants.delete(event.rideId);
    return;
  }

  if (event.eventType === 'RIDE_DRIVER_REJECTED') {
    await registry.sendToUser(event.riderId, 'ride:driver_rejected', {
      rideId: event.rideId,
      reason: event.reason,
    });
  }
}

async function handleWalletEvent(event: WalletEvent, registry: SocketRegistry): Promise<void> {
  if (event.eventType === 'WALLET_CREDITED') {
    await registry.sendToUser(event.userId, 'wallet:updated', {
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
    await registry.sendToUser(event.userId, 'wallet:updated', {
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
    await registry.sendToUser(event.userId, 'wallet:updated', {
      walletId: event.walletId,
      rideId: event.rideId,
      lockedAmountUsdt: event.lockedAmountUsdt,
      reason: event.reason,
      direction: 'lock',
    });
    return;
  }

  if (event.eventType === 'WALLET_HOLD_ADJUSTED') {
    await registry.sendToUser(event.userId, 'wallet:updated', {
      walletId: event.walletId,
      rideId: event.rideId,
      previousLockedAmountUsdt: event.previousLockedAmountUsdt,
      lockedAmountUsdt: event.lockedAmountUsdt,
      reason: event.reason,
      direction: 'lock_adjustment',
    });
    return;
  }

  await registry.sendToUser(event.userId, 'wallet:updated', {
    walletId: event.walletId,
    rideId: event.rideId,
    unlockedAmountUsdt: event.unlockedAmountUsdt,
    reason: event.reason,
    direction: 'unlock',
  });
}

async function handleNotificationEvent(event: NotificationEvent, registry: SocketRegistry): Promise<void> {
  if (event.eventType !== 'IN_APP_SEND') return;

  await registry.sendToUser(event.userId, 'notification:new', {
    notificationId: event.notificationId,
    title: event.title,
    body: event.body,
    category: event.category,
    referenceId: event.referenceId,
    referenceType: event.referenceType,
    read: event.read,
  });
}

async function handleGpsProcessedEvent(
  event: GpsProcessedEvent,
  registry: SocketRegistry,
  rideParticipants: Map<string, RideParticipantState>,
): Promise<void> {
  const participants = rideParticipants.get(event.rideId);
  if (!participants?.riderId) {
    return;
  }

  await registry.sendToUser(participants.riderId, 'ride:driver_location', {
    rideId: event.rideId,
    lat: event.lat,
    lng: event.lng,
    heading: event.headingDeg,
    speedKmh: event.speedKmh,
    distanceFromLastKm: event.distanceFromLastKm,
    totalDistanceKm: event.totalDistanceKm,
    isStale: event.isStale,
    isConsistent: event.isConsistent,
    inconsistencyReason: event.inconsistencyReason,
    ignoredDistanceKm: event.ignoredDistanceKm,
    distanceToNextStopKm: event.distanceToNextStopKm,
    nextStopAddress: event.nextStopAddress,
    nextStopOrder: event.nextStopOrder,
    remainingStopCount: event.remainingStopCount,
  });
}

async function handleComplianceEvent(event: ComplianceEvent, registry: SocketRegistry): Promise<void> {
  if (event.eventType !== 'GPS_STALE_WARNING') return;

  await registry.sendToUser(event.riderId, 'gps:stale_warning', {
    rideId: event.rideId,
    staleMinutes: event.staleMinutes,
    lastKnownLat: event.lastKnownLat,
    lastKnownLng: event.lastKnownLng,
  });
}
