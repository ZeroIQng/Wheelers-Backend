import { randomUUID } from 'node:crypto';
import type { WheelersConsumer } from '@wheleers/kafka-client';
import { referralClient, walletClient, virtualAccountClient, driverClient, userClient } from '@wheleers/db';
import {
  ComplianceEvent,
  GroupRideEvent,
  GpsProcessedEvent,
  NotificationEvent,
  RideEvent,
  WalletEvent,
  TOPICS,
} from '@wheleers/kafka-schemas';
import { calculateRideFees } from '@wheleers/config';
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
  setRideState,
  getRideState,
  getRideMeta,
  getBids,
  storeAcceptedBid,
  storeLastBatch,
  getGroupRequestRider,
} from '../whatsapp-flows/bid-state';
import type { WhatsappBid } from '../whatsapp-flows/bid-state';
import {
  sendBidNotification,
  sendRideMatchedNotification,
  sendDriverArrivedNotification,
  sendRideStartedNotification,
  sendRideCompletedNotification,
  sendRideCancelledNotification,
  sendBidTimeoutNotification,
  sendRiderPaidNotification,
  sendDepositConfirmation,
  sendGroupRideGroupedNotification,
  sendGroupRideDriverAssignedNotification,
} from '../whatsapp-flows/whatsapp-notifier';
import type { WhatsappNotifierDeps } from '../whatsapp-flows/whatsapp-notifier';
import type { GatewayPublisher } from '../websocket/publisher';

export interface StartGatewayConsumerDeps {
  consumer: WheelersConsumer;
  registry: SocketRegistry;
  redisClient: RedisClient;
  publisher: GatewayPublisher;
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
        await handleWalletEvent(parsed.data, deps, rideParticipants);
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
        await handleGroupRideEvent(parsed.data, deps);
      }
    },
  );
}

/**
 * One pending flush per ride. In-memory is acceptable here: if the gateway
 * restarts, the worst case is the swallowed bid stays hidden until the next
 * bid arrives after the debounce — the pre-fix behaviour, not a new failure.
 */
const pendingBidFlushTimers = new Map<string, NodeJS.Timeout>();

/** Just past the 30s notification debounce, so shouldNotify passes at fire time. */
const BID_FLUSH_DELAY_MS = 31_000;

function scheduleBidFlush(
  deps: StartGatewayConsumerDeps,
  rideId: string,
  riderId: string,
): void {
  if (pendingBidFlushTimers.has(rideId)) return;

  const timer = setTimeout(() => {
    pendingBidFlushTimers.delete(rideId);
    void (async () => {
      // The ride may have resolved while we waited — meta is deleted by
      // cleanupRideKeys on assign/cancel/timeout, and a rider who accepted
      // meanwhile has left the bidding state. Stay silent in those cases.
      const meta = await getRideMeta(deps.redisClient, rideId);
      const state = await getRideState(deps.redisClient, rideId);
      if (!meta || state !== 'bidding') return;

      const phone = await lookupPhoneByUserId(deps.redisClient, riderId);
      if (!phone || !deps.whatsappNotifier) return;

      if (!(await shouldNotify(deps.redisClient, rideId))) {
        // Another bid beat us to it inside a fresh window; it will flush.
        scheduleBidFlush(deps, rideId, riderId);
        return;
      }

      const allBids = await getBids(deps.redisClient, rideId);
      if (allBids.length === 0) return;

      await storeLastBatch(deps.redisClient, rideId, allBids);
      await sendBidNotification(deps.whatsappNotifier, phone, allBids, meta.offerNgn)
        .catch((err) => console.warn('[consumer] WhatsApp bid flush failed', err));
    })();
  }, BID_FLUSH_DELAY_MS);
  timer.unref();

  pendingBidFlushTimers.set(rideId, timer);
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
      pickupDistanceKm: event.pickupDistanceKm,
      pickupEtaSeconds: event.pickupEtaSeconds,
      expiresAt: event.expiresAt,
      route: event.route,
      isGroupRide: event.isGroupRide ?? false,
      riderCount: event.riderCount ?? 1,
      stopKinds: event.stopKinds ?? [],
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
        distanceKm: event.distanceKm,
        receivedAt: new Date().toISOString(),
      };
      await addBid(deps.redisClient, event.rideId, bid);
      await setRideState(deps.redisClient, event.rideId, 'bidding');

      const phone = await lookupPhoneByUserId(deps.redisClient, event.riderId);
      const meta = await getRideMeta(deps.redisClient, event.rideId);
      if (phone && meta) {
        if (await shouldNotify(deps.redisClient, event.rideId)) {
          // Fetch ALL bids and send as one batched message
          const allBids = await getBids(deps.redisClient, event.rideId);
          await storeLastBatch(deps.redisClient, event.rideId, allBids);
          await sendBidNotification(deps.whatsappNotifier, phone, allBids, meta.offerNgn)
            .catch((err) => console.warn('[consumer] WhatsApp bid notification failed', err));
        } else {
          // Debounced. The bid is in Redis but the rider has NOT seen it — and
          // acceptance reads getLastBatch (what was actually sent), so a bid
          // that is never flushed is not just invisible, it is unacceptable.
          // That was the hole: a driver re-bidding within 30s of the previous
          // notification vanished from the rider's view forever. Flush once
          // the debounce window ends.
          scheduleBidFlush(deps, event.rideId, event.riderId);
        }
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
        distanceKm: event.distanceKm,
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
      await cleanupRideKeys(deps.redisClient, event.rideId);
    } else {
      await registry.sendToUser(event.riderId, 'ride:bid_timeout', {
        rideId: event.rideId,
      });
    }
    rideParticipants.delete(event.rideId);
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
      await setRideState(deps.redisClient, event.rideId, 'confirmed');

      // Store accepted bid for driver profile flow
      try {
        const driver = await driverClient.findById(event.driverId);
        await storeAcceptedBid(deps.redisClient, event.rideId, {
          driverName: event.driverName,
          driverPhone: driver.user.phone ?? '',
          driverUserId: event.driverUserId,
          vehicleModel: event.vehicleModel,
          vehiclePlate: event.vehiclePlate ?? '',
          vehicleColor: '',
          driverRating: event.driverRating ?? 0,
          totalRides: driver.totalRides ?? 0,
          etaSeconds: event.etaSeconds,
          fareNgn: event.agreedFareNgn,
        });
      } catch {
        // Non-critical
      }

      const phone = await lookupPhoneByUserId(deps.redisClient, event.riderId);
      if (phone) {
        await sendRideMatchedNotification(
          deps.whatsappNotifier, phone,
          event.driverName, event.vehicleModel,
          event.vehiclePlate ?? '', event.etaSeconds,
          event.agreedFareNgn, event.driverRating ?? 0,
        ).catch(() => {});
      }
    } else {
      const riderMatchFees = calculateRideFees(event.agreedFareNgn);

      // Look up driver phone so rider can call them
      let driverPhone: string | undefined;
      try {
        const driver = await driverClient.findById(event.driverId);
        driverPhone = driver.user.phone ?? undefined;
      } catch { /* non-critical */ }

      await registry.sendToUser(event.riderId, 'ride:matched', {
        rideId: event.rideId,
        driverId: event.driverId,
        driverName: event.driverName,
        driverRating: event.driverRating,
        vehiclePlate: event.vehiclePlate,
        vehicleModel: event.vehicleModel,
        etaSeconds: event.etaSeconds,
        agreedFareNgn: riderMatchFees.totalNgn,
        lockedFareNgn: event.lockedFareNgn,
        paymentMethod: event.paymentMethod,
        driverPhone,
      });

      // Push too — the socket only reaches a foregrounded app, and "driver
      // on the way" is exactly the message a backgrounded rider must see.
      const etaMin = Math.max(1, Math.ceil(event.etaSeconds / 60));
      await deps.publisher.publishNotificationEvent({
        eventType: 'PUSH_SEND',
        notificationId: randomUUID(),
        userId: event.riderId,
        title: 'Driver found! 🚗',
        body: `${event.driverName} is on the way — they'll be with you in ~${etaMin} min.`,
        data: { type: 'ride:matched', rideId: event.rideId },
        priority: 'high',
        timestamp: new Date().toISOString(),
      }).catch(() => {});
    }

    // Notify driver via WebSocket (app) — include fee breakdown
    const matchFees = calculateRideFees(event.agreedFareNgn);

    // Look up rider phone so driver can call them
    let riderPhone: string | undefined;
    try {
      const riderUser = await userClient.findById(event.riderId);
      riderPhone = riderUser?.phone ?? undefined;
    } catch { /* non-critical */ }

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
      vatNgn: matchFees.vatNgn,
      stateLevyNgn: matchFees.stateLevyNgn,
      serviceFeeNgn: matchFees.serviceFeeNgn,
      driverEarningsNgn: matchFees.driverPayoutNgn,
      lockedFareNgn: event.lockedFareNgn,
      paymentMethod: event.paymentMethod,
      riderPaid: true,
      riderPhone,
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

  if (event.eventType === 'RIDE_ARRIVED') {
    // The "your driver is outside" moment. WhatsApp riders get a message; app
    // riders get a socket event their ride screen can react to.
    const waRider = await isWhatsappRider(deps.redisClient, event.riderId);
    if (waRider && deps.whatsappNotifier) {
      const phone = await lookupPhoneByUserId(deps.redisClient, event.riderId);
      if (phone) {
        await sendDriverArrivedNotification(deps.whatsappNotifier, phone).catch(() => {});
      }
    } else {
      await registry.sendToUser(event.riderId, 'ride:driver_arrived', {
        rideId: event.rideId,
        driverId: event.driverId,
      });
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
      await setRideState(deps.redisClient, event.rideId, 'in_progress');
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
      const riderFees = calculateRideFees(event.fareNgn);
      await registry.sendToUser(event.riderId, 'ride:completed', {
        rideId: event.rideId,
        fareNgn: riderFees.totalNgn,
        distanceKm: event.distanceKm,
        durationSeconds: event.durationSeconds,
        completedAt: event.completedAt,
        referralCashbackSettled: settledReferralUsages > 0,
      });
    }

    // Notify driver via WebSocket (app) — show earnings breakdown
    const completionFees = calculateRideFees(event.fareNgn);
    await registry.sendToUser(event.driverUserId, 'ride:completed', {
      rideId: event.rideId,
      fareNgn: event.fareNgn,
      vatNgn: completionFees.vatNgn,
      stateLevyNgn: completionFees.stateLevyNgn,
      serviceFeeNgn: completionFees.serviceFeeNgn,
      totalChargedNgn: completionFees.totalNgn,
      driverEarningsNgn: completionFees.driverPayoutNgn,
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
    // Release wallet hold so locked funds return to rider's balance
    await walletClient.cancelRideHold(event.rideId).catch(() => {});

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
        cancelledBy: event.cancelledBy ?? 'rider',
        referralCashbackReleasedNgn:
          releasedReferralCashback.releasedCashbackNgn,
      });
    }

    // Notify driver via WebSocket (app).
    // rideParticipants is in-memory and only filled by RIDE_REQUESTED /
    // RIDE_DRIVER_ASSIGNED, so any gateway restart empties it and the driver
    // silently got nothing. Fall back to the DB, which always knows.
    if (event.driverId) {
      const participants = rideParticipants.get(event.rideId);
      let driverUserId = participants?.driverUserId ?? event.driverUserId;

      if (!driverUserId) {
        const driver = await driverClient.findById(event.driverId).catch((error) => {
          console.warn('[gateway] could not resolve driver user for cancellation', {
            rideId: event.rideId,
            driverId: event.driverId,
            error: error instanceof Error ? error.message : String(error),
          });
          return null;
        });
        driverUserId = driver?.userId;
      }

      if (driverUserId) {
        await registry.sendToUser(driverUserId, 'ride:cancelled', {
          rideId: event.rideId,
          reason: event.reason,
          cancelledBy: event.cancelledBy ?? 'rider',
        });
      } else {
        console.warn('[gateway] ride cancelled but the driver could not be notified', {
          rideId: event.rideId,
          driverId: event.driverId,
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

async function handleWalletEvent(
  event: WalletEvent,
  deps: StartGatewayConsumerDeps,
  rideParticipants: Map<string, RideParticipantState>,
): Promise<void> {
  const registry = deps.registry;

  if (event.eventType === 'WALLET_CREDITED') {
    await registry.sendToUser(event.userId, 'wallet:updated', {
      walletId: event.walletId,
      balanceNgn: event.newBalanceNgn,
      changeNgn: event.amountNgn,
      changeType: event.creditType,
      direction: 'credit',
      referenceId: event.referenceId,
    });

    // Check if this rider has an active ride — notify driver that rider funded wallet
    const waRider = await isWhatsappRider(deps.redisClient, event.userId);
    let handledByRide = false;

    if (waRider && deps.whatsappNotifier) {
      // Find the active ride and its driver
      for (const [rideId, participants] of rideParticipants) {
        if (participants.riderId === event.userId && participants.driverUserId) {
          const meta = await getRideMeta(deps.redisClient, rideId);
          if (meta && event.newBalanceNgn >= meta.offerNgn) {
            // Rider has enough funds — notify driver via app
            await registry.sendToUser(participants.driverUserId, 'ride:rider_paid', {
              rideId,
              riderFunded: true,
              message: 'Rider has funded their wallet. You can start heading to pickup!',
            });
            // Also send WhatsApp confirmation to rider
            const phone = await lookupPhoneByUserId(deps.redisClient, event.userId);
            if (phone) {
              await sendRiderPaidNotification(deps.whatsappNotifier, phone, event.newBalanceNgn)
                .catch(() => {});
            }
            handledByRide = true;
          }
          break;
        }
      }
    }

    // No active ride — send generic deposit confirmation to WhatsApp users
    if (!handledByRide && deps.whatsappNotifier && event.creditType === 'deposit') {
      const phone = await lookupPhoneByUserId(deps.redisClient, event.userId);
      if (phone) {
        await sendDepositConfirmation(deps.whatsappNotifier, phone, event.amountNgn, event.newBalanceNgn)
          .catch(() => {});
      }
    }

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

  // Send to rider — full location data
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

  // Send to driver — live distance for trip screen
  if (participants.driverUserId) {
    await registry.sendToUser(participants.driverUserId, 'ride:gps_update', {
      rideId: event.rideId,
      totalDistanceKm: event.totalDistanceKm,
      distanceToNextStopKm: event.distanceToNextStopKm,
    });
  }
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

/**
 * A group rider who booked over WhatsApp has no socket — resolve their phone
 * so status updates reach the channel they actually used.
 */
async function resolveGroupRiderPhone(
  deps: StartGatewayConsumerDeps,
  riderId: string,
): Promise<string | null> {
  const isGroupWhatsappRider = await getGroupRequestRider(deps.redisClient, riderId).catch(() => null);
  if (!isGroupWhatsappRider) return null;

  const cached = await lookupPhoneByUserId(deps.redisClient, riderId);
  if (cached) return cached;

  try {
    const user = await userClient.findById(riderId);
    return user?.phone ?? null;
  } catch {
    return null;
  }
}

async function handleGroupRideEvent(
  event: GroupRideEvent,
  deps: StartGatewayConsumerDeps,
): Promise<void> {
  const registry = deps.registry;

  if (event.eventType === 'GROUP_RIDE_ROUTE_BUILT') {
    const riderCount = event.riderIds.length;
    for (const riderId of event.riderIds) {
      const phone = deps.whatsappNotifier ? await resolveGroupRiderPhone(deps, riderId) : null;
      if (phone && deps.whatsappNotifier) {
        await sendGroupRideGroupedNotification(
          deps.whatsappNotifier, phone,
          riderCount, event.totalDistanceKm, event.totalDurationSeconds,
        ).catch(() => {});
      } else {
        await registry.sendToUser(riderId, 'group-ride:grouped', {
          groupId: event.groupId,
          rideIds: event.rideIds,
          riderCount,
          totalDistanceKm: event.totalDistanceKm,
          totalDurationSeconds: event.totalDurationSeconds,
        });
      }
    }
    return;
  }

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

    // Notify ALL riders in the group — WhatsApp riders on WhatsApp
    for (const riderId of event.riderIds) {
      const phone = deps.whatsappNotifier ? await resolveGroupRiderPhone(deps, riderId) : null;
      if (phone && deps.whatsappNotifier) {
        await sendGroupRideDriverAssignedNotification(
          deps.whatsappNotifier, phone,
          event.driverName, event.vehicleModel, event.vehiclePlate,
          event.driverRating, event.etaSeconds,
        ).catch(() => {});
      } else {
        await registry.sendToUser(riderId, 'group-ride:driver-assigned', payload);
      }
    }
  }
}
