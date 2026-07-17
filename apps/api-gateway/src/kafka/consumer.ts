import type { WheelersConsumer } from '@wheleers/kafka-client';
import { referralClient } from '@wheleers/db';
import {
  ComplianceEvent,
  GroupRideEvent,
  GpsProcessedEvent,
  NotificationEvent,
  RideEvent,
  WalletEvent,
  TOPICS,
} from '@wheleers/kafka-schemas';
import { buildRideEstimatePricing } from '../pricing/ride-estimate';
import { SocketRegistry } from '../websocket/registry';
import type { RedisClient } from '../redis/client';
import {
  isWhatsappRider,
  lookupPhoneByUserId,
  addBid,
  shouldNotify,
  clearActiveRide,
  cleanupRideKeys,
} from '../whatsapp-flows/bid-state';
import type { WhatsappBid } from '../whatsapp-flows/bid-state';
import {
  sendBidNotification,
  sendRideMatchedNotification,
  sendRideStartedNotification,
  sendRideCompletedNotification,
  sendRideCancelledNotification,
  sendBidTimeoutNotification,
} from '../whatsapp-flows/whatsapp-notifier';
import type { WhatsappNotifierDeps } from '../whatsapp-flows/whatsapp-notifier';

export interface StartGatewayConsumerDeps {
  consumer: WheelersConsumer;
  registry: SocketRegistry;
  redisClient: RedisClient;
  whatsappNotifier?: WhatsappNotifierDeps;
}

interface RideParticipantState {
  riderId: string;
  driverUserId?: string;
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
      TOPICS.GROUP_RIDE_EVENTS,
    ],
    async (value, context) => {
      if (context.topic === TOPICS.RIDE_EVENTS) {
        const parsed = RideEvent.safeParse(value);
        if (!parsed.success) {
          throw new Error(`Invalid ride event: ${parsed.error.message}`);
        }
        await handleRideEvent(parsed.data, deps, rideParticipants);
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
        return;
      }

      if (context.topic === TOPICS.GROUP_RIDE_EVENTS) {
        const parsed = GroupRideEvent.safeParse(value);
        if (!parsed.success) {
          throw new Error(`Invalid group ride event: ${parsed.error.message}`);
        }
        await handleGroupRideEvent(parsed.data, deps.registry);
      }
    },
  );
}

async function handleRideEvent(
  event: RideEvent,
  deps: StartGatewayConsumerDeps,
  rideParticipants: Map<string, RideParticipantState>,
): Promise<void> {
  const registry = deps.registry;
  if (event.eventType === 'RIDE_REQUESTED') {
    rideParticipants.set(event.rideId, { riderId: event.riderId });
    return;
  }

  if (event.eventType === 'RIDE_OFFER_SENT') {
    await registry.sendToUser(event.driverUserId, 'ride:offer', {
      rideId: event.rideId,
      riderId: event.riderId,
      pickup: event.pickup,
      destination: event.destination,
      stops: event.stops,
      fareEstimateNgn: event.fareEstimateNgn,
      paymentMethod: event.paymentMethod,
      riderOfferNgn: event.riderOfferNgn,
      suggestedFareNgn: event.suggestedFareNgn,
      ratePerKmNgn: event.ratePerKmNgn,
      plannedDistanceKm: event.plannedDistanceKm,
      plannedDurationSeconds: event.plannedDurationSeconds,
      expiresAt: event.expiresAt,
      route: event.route,
    });
    return;
  }

  if (event.eventType === 'RIDE_COUNTER_OFFER') {
    const waRider = await isWhatsappRider(deps.redisClient, event.riderId);
    if (waRider && deps.whatsappNotifier) {
      const bid: WhatsappBid = {
        driverId: event.driverId,
        driverUserId: event.driverUserId,
        counterOfferNgn: event.counterOfferNgn,
        driverName: event.driverName,
        driverRating: event.driverRating,
        vehiclePlate: event.vehiclePlate,
        vehicleModel: event.vehicleModel,
        etaSeconds: event.etaSeconds,
        receivedAt: new Date().toISOString(),
      };
      const bidCount = await addBid(deps.redisClient, event.rideId, bid);
      const phone = await lookupPhoneByUserId(deps.redisClient, event.riderId);
      if (phone && await shouldNotify(deps.redisClient, event.rideId)) {
        await sendBidNotification(deps.whatsappNotifier, phone, event.rideId, bidCount, event.riderId)
          .catch((err) => console.warn('[consumer] WhatsApp bid notification failed', err));
      }
    } else {
      await registry.sendToUser(event.riderId, 'ride:counter_offer', {
        rideId: event.rideId,
        driverId: event.driverId,
        driverUserId: event.driverUserId,
        counterOfferNgn: event.counterOfferNgn,
        driverName: event.driverName,
        driverRating: event.driverRating,
        vehiclePlate: event.vehiclePlate,
        vehicleModel: event.vehicleModel,
        etaSeconds: event.etaSeconds,
      });
    }
    return;
  }

  if (event.eventType === 'RIDE_RIDER_COUNTER_OFFER') {
    // Confirm to the rider (for app riders on WebSocket)
    await registry.sendToUser(event.riderId, 'ride:rider_counter_offer:confirmed', {
      rideId: event.rideId,
      driverId: event.driverId,
      counterOfferNgn: event.counterOfferNgn,
    });
    // Driver notification is handled when ride-service re-broadcasts RIDE_OFFER_SENT
    // with the updated riderOfferNgn — the RIDE_OFFER_SENT handler above bridges to WhatsApp.
    return;
  }

  if (event.eventType === 'RIDE_OFFER_ACCEPTED') {
    await registry.sendToUser(event.driverUserId, 'ride:offer_accepted', {
      rideId: event.rideId,
      riderId: event.riderId,
      agreedFareNgn: event.agreedFareNgn,
      paymentMethod: event.paymentMethod,
    });
    return;
  }

  if (event.eventType === 'RIDE_BID_TIMEOUT') {
    const waRider = await isWhatsappRider(deps.redisClient, event.riderId);
    if (waRider && deps.whatsappNotifier) {
      const phone = await lookupPhoneByUserId(deps.redisClient, event.riderId);
      if (phone) {
        await sendBidTimeoutNotification(deps.whatsappNotifier, phone).catch(() => {});
      }
      await clearActiveRide(deps.redisClient, event.riderId);
    } else {
      await registry.sendToUser(event.riderId, 'ride:bid_timeout', {
        rideId: event.rideId,
      });
    }
    return;
  }

  if (event.eventType === 'RIDE_DRIVER_ASSIGNED') {
    rideParticipants.set(event.rideId, {
      riderId: event.riderId,
      driverUserId: event.driverUserId,
    });

    // Notify rider
    const waRider = await isWhatsappRider(deps.redisClient, event.riderId);
    if (waRider && deps.whatsappNotifier) {
      const phone = await lookupPhoneByUserId(deps.redisClient, event.riderId);
      if (phone) {
        await sendRideMatchedNotification(
          deps.whatsappNotifier, phone,
          event.driverName, event.vehicleModel, event.etaSeconds, event.agreedFareNgn,
        ).catch(() => {});
      }
    } else {
      await registry.sendToUser(event.riderId, 'ride:matched', {
        rideId: event.rideId,
        driverId: event.driverId,
        driverName: event.driverName,
        driverRating: event.driverRating,
        vehiclePlate: event.vehiclePlate,
        vehicleModel: event.vehicleModel,
        etaSeconds: event.etaSeconds,
        agreedFareNgn: event.agreedFareNgn,
        lockedFareNgn: event.lockedFareNgn,
        paymentMethod: event.paymentMethod,
      });
    }

    // Notify driver via WebSocket (app)
    await registry.sendToUser(event.driverUserId, 'ride:matched', {
      rideId: event.rideId,
      riderId: event.riderId,
      driverId: event.driverId,
      driverName: event.driverName,
      driverRating: event.driverRating,
      vehiclePlate: event.vehiclePlate,
      vehicleModel: event.vehicleModel,
      etaSeconds: event.etaSeconds,
      agreedFareNgn: event.agreedFareNgn,
      lockedFareNgn: event.lockedFareNgn,
      paymentMethod: event.paymentMethod,
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
      ...buildRideEstimatePricing(event.plannedDistanceKm),
      updatedBy: event.updatedBy,
    };

    await registry.sendToUser(event.riderId, 'ride:route:updated', routePayload);

    const participants = rideParticipants.get(event.rideId);
    if (participants?.driverUserId) {
      await registry.sendToUser(participants.driverUserId, 'ride:route:updated', routePayload);
    }

    return;
  }

  if (event.eventType === 'RIDE_STARTED') {
    // RIDE_STARTED only has driverId (Driver record ID), not driverUserId.
    // Look up driverUserId from rideParticipants (set by RIDE_DRIVER_ASSIGNED).
    const participants = rideParticipants.get(event.rideId);
    const driverUserId = participants?.driverUserId;

    // Notify rider
    const waRider = await isWhatsappRider(deps.redisClient, event.riderId);
    if (waRider && deps.whatsappNotifier) {
      const phone = await lookupPhoneByUserId(deps.redisClient, event.riderId);
      if (phone) {
        await sendRideStartedNotification(deps.whatsappNotifier, phone).catch(() => {});
      }
    } else {
      await registry.sendToUser(event.riderId, 'ride:started', {
        rideId: event.rideId,
        startedAt: event.startedAt,
      });
    }

    // Notify driver via WebSocket (app)
    if (driverUserId) {
      await registry.sendToUser(driverUserId, 'ride:started', {
        rideId: event.rideId,
        startedAt: event.startedAt,
      });
    }

    return;
  }

  if (event.eventType === 'RIDE_COMPLETED') {
    const settledReferralUsages = await referralClient.settleRideCashback(event.rideId);

    // Notify rider
    const waRider = await isWhatsappRider(deps.redisClient, event.riderId);
    if (waRider && deps.whatsappNotifier) {
      const phone = await lookupPhoneByUserId(deps.redisClient, event.riderId);
      if (phone) {
        await sendRideCompletedNotification(
          deps.whatsappNotifier, phone, event.fareNgn, event.distanceKm,
        ).catch(() => {});
      }
      await clearActiveRide(deps.redisClient, event.riderId);
    } else {
      await registry.sendToUser(event.riderId, 'ride:completed', {
        rideId: event.rideId,
        fareNgn: event.fareNgn,
        distanceKm: event.distanceKm,
        durationSeconds: event.durationSeconds,
        completedAt: event.completedAt,
        referralCashbackSettled: settledReferralUsages > 0,
      });
    }

    // Notify driver via WebSocket (app)
    await registry.sendToUser(event.driverUserId, 'ride:completed', {
      rideId: event.rideId,
      fareNgn: event.fareNgn,
      distanceKm: event.distanceKm,
      durationSeconds: event.durationSeconds,
      completedAt: event.completedAt,
    });

    // Clean up WhatsApp Redis state
    await cleanupRideKeys(deps.redisClient, event.rideId);

    rideParticipants.delete(event.rideId);
    return;
  }

  if (event.eventType === 'RIDE_CANCELLED') {
    const releasedReferralCashback = await referralClient.releaseRideCashback(
      event.rideId,
    );

    // Notify rider
    const waRider = await isWhatsappRider(deps.redisClient, event.riderId);
    if (waRider && deps.whatsappNotifier) {
      const phone = await lookupPhoneByUserId(deps.redisClient, event.riderId);
      if (phone) {
        await sendRideCancelledNotification(deps.whatsappNotifier, phone, event.reason).catch(() => {});
      }
      await clearActiveRide(deps.redisClient, event.riderId);
    } else {
      await registry.sendToUser(event.riderId, 'ride:cancelled', {
        rideId: event.rideId,
        reason: event.reason,
        referralCashbackReleasedNgn:
          releasedReferralCashback.releasedCashbackNgn,
      });
    }

    // Notify driver via WebSocket (app)
    if (event.driverId) {
      const participants = rideParticipants.get(event.rideId);
      const driverUserId = participants?.driverUserId;
      if (driverUserId) {
        await registry.sendToUser(driverUserId, 'ride:cancelled', {
          rideId: event.rideId,
          reason: event.reason,
        });
      }
    }

    // Clean up WhatsApp Redis state for this ride
    await cleanupRideKeys(deps.redisClient, event.rideId);
    await clearActiveRide(deps.redisClient, event.riderId).catch(() => {});

    rideParticipants.delete(event.rideId);
    return;
  }

  if (event.eventType === 'RIDE_DRIVER_REJECTED') {
    await registry.sendToUser(event.riderId, 'ride:driver_rejected', {
      rideId: event.rideId,
      reason: event.reason,
    });
    return;
  }

  if (event.eventType === 'CHAT_MESSAGE_SENT') {
    const chatPayload = {
      messageId: event.messageId,
      rideId: event.rideId,
      senderId: event.senderId,
      senderRole: event.senderRole,
      content: event.content,
      createdAt: event.timestamp,
    };

    // Send to both participants — the rideParticipants map has riderId + driverId
    const participants = rideParticipants.get(event.rideId);
    if (participants?.riderId) {
      await registry.sendToUser(participants.riderId, 'chat:message', chatPayload);
    }
    if (participants?.driverUserId) {
      await registry.sendToUser(participants.driverUserId, 'chat:message', chatPayload);
    }
  }
}

async function handleWalletEvent(event: WalletEvent, registry: SocketRegistry): Promise<void> {
  if (event.eventType === 'WALLET_CREDITED') {
    await registry.sendToUser(event.userId, 'wallet:updated', {
      walletId: event.walletId,
      balanceNgn: event.newBalanceNgn,
      changeNgn: event.amountNgn,
      changeType: event.creditType,
      direction: 'credit',
      referenceId: event.referenceId,
    });
    return;
  }

  if (event.eventType === 'WALLET_DEBITED') {
    await registry.sendToUser(event.userId, 'wallet:updated', {
      walletId: event.walletId,
      balanceNgn: event.newBalanceNgn,
      changeNgn: event.amountNgn,
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
      lockedAmountNgn: event.lockedAmountNgn,
      reason: event.reason,
      direction: 'lock',
    });
    return;
  }

  if (event.eventType === 'WALLET_HOLD_ADJUSTED') {
    await registry.sendToUser(event.userId, 'wallet:updated', {
      walletId: event.walletId,
      rideId: event.rideId,
      previousLockedAmountNgn: event.previousLockedAmountNgn,
      lockedAmountNgn: event.lockedAmountNgn,
      reason: event.reason,
      direction: 'lock_adjustment',
    });
    return;
  }

  await registry.sendToUser(event.userId, 'wallet:updated', {
    walletId: event.walletId,
    rideId: event.rideId,
    unlockedAmountNgn: event.unlockedAmountNgn,
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

async function handleGroupRideEvent(
  event: GroupRideEvent,
  registry: SocketRegistry,
): Promise<void> {
  if (event.eventType === 'GROUP_RIDE_DRIVER_ASSIGNED') {
    const payload = {
      groupId: event.groupId,
      rideIds: event.rideIds,
      driverId: event.driverId,
      driverUserId: event.driverUserId,
      driverName: event.driverName,
      driverRating: event.driverRating,
      vehiclePlate: event.vehiclePlate,
      vehicleModel: event.vehicleModel,
      etaSeconds: event.etaSeconds,
    };

    // Notify ALL riders in the group
    for (const riderId of event.riderIds) {
      await registry.sendToUser(riderId, 'group-ride:driver-assigned', payload);
    }
  }
}
