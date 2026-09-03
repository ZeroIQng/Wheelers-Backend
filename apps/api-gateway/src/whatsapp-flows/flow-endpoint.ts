import type { IncomingMessage, ServerResponse } from 'http';
import { randomUUID } from 'crypto';
import { GoogleMapsRoutePlanner, validateRiderOffer } from '@wheleers/config';
import { walletClient, virtualAccountClient, driverClient, rideClient } from '@wheleers/db';
import { RideOfferAcceptedEvent, RideRequestedEvent } from '@wheleers/kafka-schemas';
import type { GatewayPublisher } from '../websocket/publisher';
import type { RedisClient } from '../redis/client';
import { readRawBody, sendJson } from '../http/utils';
import { decryptFlowRequest, encryptFlowResponse, verifyFlowToken } from './encryption';
import type { DecryptedFlowRequest } from './encryption';
import type { FlowRequestBody } from './encryption';
import { geocodeAddress } from '../LLM/geocoding';
import {
  getBids,
  getRideMeta,
  getRideState,
  setRideState,
  getActiveRide,
  setActiveRide,
  storeWhatsappRide,
  getPendingLocation,
  storeFlowEstimate,
  getFlowEstimate,
  clearFlowEstimate,
  clearPendingLocation,
  clearBids,
  removeBid,
  lookupPhoneByUserId,
  storeAcceptedBid,
  getAcceptedBid,
} from './bid-state';
import type { FlowEstimate, WhatsappBid } from './bid-state';
import {
  buildBidListData,
  buildConfirmationData,
  buildDriverProfileData,
  buildPaymentData,
  buildErrorData,
  buildRideSetupData,
  buildFareConfirmData,
  buildNotifyExitData,
} from './flow-screens';
import type { DriverKycStorage } from '../storage/driver-kyc-storage';

export interface WhatsappFlowEndpointDeps {
  redisClient: RedisClient;
  publisher: GatewayPublisher;
  privateKeyPem: string;
  tokenSecret: string;
  googleMapsApiKey: string;
  routePlanner: GoogleMapsRoutePlanner;
  kycStorage?: DriverKycStorage;
}

const POLL_INTERVAL_MS = 1_000;
const POLL_MAX_MS = 4_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollForBids(
  redis: RedisClient,
  rideId: string,
  knownCount: number,
): Promise<WhatsappBid[]> {
  const deadline = Date.now() + POLL_MAX_MS;

  while (Date.now() < deadline) {
    const bids = await getBids(redis, rideId);
    if (bids.length > knownCount) return bids;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return bids;
    await sleep(Math.min(POLL_INTERVAL_MS, remaining));
  }

  return getBids(redis, rideId);
}

function parseFlowToken(flowToken: string, secret: string): { rideId: string; userId: string } | null {
  const payload = verifyFlowToken(flowToken, secret);
  if (!payload) return null;
  const parts = payload.split(':');
  if (parts.length < 2) return null;
  return { rideId: parts[0], userId: parts[1] };
}

// ── Fetch wallet + virtual account for confirmation screen ────────────────

async function getWalletInfo(userId: string) {
  const [wallet, virtualAccount] = await Promise.all([
    walletClient.findByUserId(userId).catch(() => null),
    virtualAccountClient.findByUserId(userId).catch(() => null),
  ]);

  return {
    walletBalanceNgn: wallet ? Number(wallet.balanceNgn) : 0,
    virtualAccount: virtualAccount ? {
      bankName: virtualAccount.bankName,
      accountNumber: virtualAccount.accountNumber,
      accountName: virtualAccount.accountName,
    } : null,
  };
}

// ── State-based screen router ──────────────────────────────────────────────

async function resolveScreen(
  rideId: string,
  userId: string,
  deps: WhatsappFlowEndpointDeps,
): Promise<{ screen: string; data: Record<string, unknown> }> {
  const state = await getRideState(deps.redisClient, rideId);
  const meta = await getRideMeta(deps.redisClient, rideId);

  if (!meta) {
    return { screen: 'SUCCESS', data: buildErrorData('This ride request has expired. Send a new message to book a ride.') };
  }

  if (state === 'confirmed') {
    // Find the accepted bid to show driver info
    const bids = await getBids(deps.redisClient, rideId);
    const acceptedBid = bids[0];
    return {
      screen: 'RIDE_CONFIRMED',
      data: buildConfirmationData({
        driverName: acceptedBid?.driverName ?? 'Your driver',
        vehicleModel: acceptedBid?.vehicleModel ?? 'their vehicle',
        vehiclePlate: acceptedBid?.vehiclePlate ?? '',
        etaSeconds: acceptedBid?.etaSeconds ?? 0,
        fareNgn: acceptedBid?.counterOfferNgn ?? meta.offerNgn,
        driverRating: acceptedBid?.driverRating ?? 0,
      }),
    };
  }

  // Check for bids — poll briefly if none exist yet
  let bids = await getBids(deps.redisClient, rideId);

  if (bids.length === 0 && state === 'searching') {
    bids = await pollForBids(deps.redisClient, rideId, 0);
  }

  if (bids.length > 0) {
    if (state === 'searching') {
      await setRideState(deps.redisClient, rideId, 'bidding');
    }
    return { screen: 'BID_LIST', data: buildBidListData(meta, bids) };
  }

  // No bids yet — tell rider we'll notify them
  return {
    screen: 'SUCCESS',
    data: buildNotifyExitData("We're looking for drivers! You'll get a notification as soon as someone is interested."),
  };
}

// ── Main flow action handler ───────────────────────────────────────────────

async function handleFlowAction(
  body: FlowRequestBody,
  deps: WhatsappFlowEndpointDeps,
): Promise<{ screen: string; data: Record<string, unknown> }> {
  if (body.action === 'ping') {
    return { screen: 'SUCCESS', data: { status: 'active' } };
  }

  const tokenData = parseFlowToken(body.flow_token, deps.tokenSecret);
  if (!tokenData) {
    return { screen: 'SUCCESS', data: buildErrorData('Invalid session. Please try again.') };
  }

  const { rideId, userId } = tokenData;

  // ── INIT — show appropriate screen based on ride state ────────────────

  if (body.action === 'INIT') {
    if (rideId === 'new') {
      return await handleRideSetupInit(userId, deps);
    }
    return await resolveScreen(rideId, userId, deps);
  }

  // ── BACK — return to appropriate screen ───────────────────────────────

  if (body.action === 'BACK') {
    if (rideId === 'new') {
      return await handleRideSetupInit(userId, deps);
    }
    return await resolveScreen(rideId, userId, deps);
  }

  // ── data_exchange — handle user actions ───────────────────────────────

  if (body.action === 'data_exchange') {
    const data = body.data ?? {};
    const action = data.action as string | undefined;

    // ── RIDE_SETUP: estimate fare, show FARE_CONFIRM ────────────────────
    if (action === 'estimate_fare') {
      return await handleEstimateFare(userId, data, deps);
    }

    // ── FARE_CONFIRM: find drivers ──────────────────────────────────────
    if (action === 'find_drivers') {
      return await handleFindDrivers(userId, data, deps);
    }

    // Need a valid ride from here on
    const meta = await getRideMeta(deps.redisClient, rideId);
    if (!meta) {
      return { screen: 'SUCCESS', data: buildErrorData('This ride request has expired. Send a new message to book a ride.') };
    }

    // ── BID_LIST actions: accept / decline ───────────────────────────
    if (action === 'bid_action') {
      const bidAction = data.bid_action as string;
      const selectedBid = data.selected_bid as string | undefined;
      const adjustAmount = Number(data.adjust_amount);

      // If rider filled in adjust amount, update their offer in Redis
      if (!isNaN(adjustAmount) && adjustAmount >= 100) {
        meta.offerNgn = adjustAmount;
        await deps.redisClient.set(
          `whatsapp:ride:${rideId}:meta`,
          JSON.stringify(meta),
          900,
        );
      }

      if (bidAction === 'accept' && selectedBid) {
        return await handleAcceptBid(rideId, userId, selectedBid, meta, deps);
      }

      if (bidAction === 'decline' && selectedBid) {
        return await handleDeclineBid(rideId, userId, selectedBid, meta, deps);
      }
    }

    // ── RIDE_CONFIRMED: view driver profile ─────────────────────────
    if (action === 'view_driver_profile') {
      return await handleViewDriverProfile(rideId, deps);
    }

    // ── DRIVER_PROFILE: view payment ─────────────────────────────────
    if (action === 'view_payment') {
      return await handleViewPayment(userId, meta);
    }

    // Default: resolve based on state
    return await resolveScreen(rideId, userId, deps);
  }

  return { screen: 'SUCCESS', data: buildErrorData('Something went wrong. Please try again.') };
}

// ── Accept selected driver ──────────────────────────────────────────────

async function handleAcceptBid(
  rideId: string,
  userId: string,
  selectedBid: string,
  meta: NonNullable<Awaited<ReturnType<typeof getRideMeta>>>,
  deps: WhatsappFlowEndpointDeps,
): Promise<{ screen: string; data: Record<string, unknown> }> {
  const bids = await getBids(deps.redisClient, rideId);
  const key = selectedBid.replace('bid-', '');
  const bid = bids.find((b) => b.driverId === key) ?? bids[parseInt(key, 10)];

  if (!bid) {
    return { screen: 'BID_LIST', data: buildBidListData(meta, bids) };
  }

  // ── The moment of commitment — SAME guards as the chat pay path and the
  // app's ride:accept_offer. This used to publish the accept blind, which
  // is exactly the class of bug (driver sold twice, unsecured rides) the
  // marketplace overhaul removed. The flow must never be a way around it.
  const driver = await driverClient.findById(bid.driverId).catch(() => null);
  const driverFresh =
    driver?.lastSeenAt != null && Date.now() - driver.lastSeenAt.getTime() < 2 * 60_000;
  const driverBusy = driver
    ? await rideClient.findActiveByDriver(bid.driverId).catch(() => null)
    : null;
  if (!driver || driver.status !== 'ONLINE' || !driverFresh || driverBusy) {
    const remaining = await removeBid(deps.redisClient, rideId, bid.driverId);
    if (remaining.length > 0) {
      return { screen: 'BID_LIST', data: buildBidListData(meta, remaining) };
    }
    await setRideState(deps.redisClient, rideId, 'searching');
    return {
      screen: 'SUCCESS',
      data: buildNotifyExitData(`${bid.driverName} just became unavailable — your money has not moved. We'll notify you when new drivers bid.`),
    };
  }

  // No hold, no match — the fare is locked before the accept is published.
  const wallet = await walletClient.findByUserId(userId).catch(() => null);
  const balanceNgn = wallet ? Number(wallet.balanceNgn) : 0;
  if (!wallet || balanceNgn < bid.counterOfferNgn) {
    const { virtualAccount } = await getWalletInfo(userId);
    const shortage = bid.counterOfferNgn - balanceNgn;
    const topUp = virtualAccount
      ? ` Top up via ${virtualAccount.bankName} ${virtualAccount.accountNumber} (${virtualAccount.accountName}), then open the ride again.`
      : ' Top up your wallet, then open the ride again.';
    return {
      screen: 'SUCCESS',
      data: buildErrorData(
        `Your wallet holds ₦${balanceNgn.toLocaleString()} but this ride costs ₦${bid.counterOfferNgn.toLocaleString()} — ₦${shortage.toLocaleString()} short.${topUp}`,
      ),
    };
  }
  try {
    await walletClient.createRideHold({
      rideId,
      walletId: wallet.id,
      riderId: userId,
      driverUserId: bid.driverUserId,
      amountNgn: bid.counterOfferNgn,
    });
  } catch {
    return {
      screen: 'SUCCESS',
      data: buildErrorData('Could not lock funds in your wallet. Please try again.'),
    };
  }

  const acceptEvent = RideOfferAcceptedEvent.parse({
    eventType: 'RIDE_OFFER_ACCEPTED',
    rideId,
    riderId: userId,
    driverId: bid.driverId,
    driverUserId: bid.driverUserId,
    bidId: bid.bidId,
    agreedFareNgn: bid.counterOfferNgn,
    paymentMethod: 'WALLET',
    timestamp: new Date().toISOString(),
  });
  await deps.publisher.publishRideEvent(acceptEvent);
  await setRideState(deps.redisClient, rideId, 'confirmed');

  // Fetch driver details for profile flow
  let driverPhone = '';
  let vehicleColor = '';
  let totalRides = 0;
  try {
    const driver = await driverClient.findById(bid.driverId);
    driverPhone = driver.user.phone ?? '';
    vehicleColor = '';
    totalRides = driver.totalRides ?? 0;
  } catch {
    // Driver lookup failed — continue without phone
  }

  await storeAcceptedBid(deps.redisClient, rideId, {
    driverName: bid.driverName,
    driverPhone,
    driverUserId: bid.driverUserId,
    vehicleModel: bid.vehicleModel,
    vehiclePlate: bid.vehiclePlate,
    vehicleColor,
    driverRating: bid.driverRating,
    totalRides,
    etaSeconds: bid.etaSeconds,
    fareNgn: bid.counterOfferNgn,
  });

  return {
    screen: 'RIDE_CONFIRMED',
    data: buildConfirmationData({
      driverName: bid.driverName,
      vehicleModel: bid.vehicleModel,
      vehiclePlate: bid.vehiclePlate,
      etaSeconds: bid.etaSeconds,
      fareNgn: bid.counterOfferNgn,
      driverRating: bid.driverRating,
    }),
  };
}

// ── Decline selected driver ─────────────────────────────────────────────

async function handleDeclineBid(
  rideId: string,
  userId: string,
  selectedBid: string,
  meta: NonNullable<Awaited<ReturnType<typeof getRideMeta>>>,
  deps: WhatsappFlowEndpointDeps,
): Promise<{ screen: string; data: Record<string, unknown> }> {
  const bids = await getBids(deps.redisClient, rideId);
  const declineKey = selectedBid.replace('bid-', '');
  const bid = bids.find((b) => b.driverId === declineKey) ?? bids[parseInt(declineKey, 10)];

  if (bid) {
    const remaining = await removeBid(deps.redisClient, rideId, bid.driverId);

    if (remaining.length > 0) {
      return { screen: 'BID_LIST', data: buildBidListData(meta, remaining) };
    }

    // No bids left — go back to searching
    await setRideState(deps.redisClient, rideId, 'searching');
    return {
      screen: 'SUCCESS',
      data: buildNotifyExitData('Driver declined. We\'ll notify you when new drivers bid.'),
    };
  }

  return { screen: 'BID_LIST', data: buildBidListData(meta, bids) };
}

// ── View driver profile screen ──────────────────────────────────────────

async function handleViewDriverProfile(
  rideId: string,
  deps: WhatsappFlowEndpointDeps,
): Promise<{ screen: string; data: Record<string, unknown> }> {
  const acceptedBid = await getAcceptedBid(deps.redisClient, rideId);

  if (!acceptedBid) {
    return { screen: 'SUCCESS', data: buildErrorData('Driver info not available yet.') };
  }

  const etaMin = Math.ceil(acceptedBid.etaSeconds / 60);

  // Fetch driver selfie + first vehicle photo from R2 storage
  let driverPhoto = '';
  let vehiclePhoto = '';
  if (deps.kycStorage) {
    try {
      const driver = await driverClient.findByUserId(acceptedBid.driverUserId ?? '');
      if (driver) {
        const kycSubmission = await driverClient.findKycSubmission(driver.id);
        if (kycSubmission?.selfieKey) {
          driverPhoto = await deps.kycStorage.getImageAsBase64(kycSubmission.selfieKey) ?? '';
        }
        if (kycSubmission?.vehicleImageKeys?.length) {
          vehiclePhoto = await deps.kycStorage.getImageAsBase64(kycSubmission.vehicleImageKeys[0]) ?? '';
        }
      }
    } catch {
      // Non-critical — show profile without photos
    }
  }

  return {
    screen: 'DRIVER_PROFILE',
    data: buildDriverProfileData({
      driverName: acceptedBid.driverName,
      phoneNumber: acceptedBid.driverPhone,
      vehicleInfo: acceptedBid.vehicleColor
        ? `${acceptedBid.vehicleColor} ${acceptedBid.vehicleModel}`
        : acceptedBid.vehicleModel,
      vehiclePlate: acceptedBid.vehiclePlate,
      ratingInfo: `${acceptedBid.driverRating.toFixed(1)}★ · ${acceptedBid.totalRides} rides`,
      eta: `${etaMin} minute${etaMin === 1 ? '' : 's'} away`,
      fare: `₦${acceptedBid.fareNgn.toLocaleString()}`,
      driverPhoto,
      vehiclePhoto,
    }),
  };
}

// ── View payment screen ─────────────────────────────────────────────────

async function handleViewPayment(
  userId: string,
  meta: NonNullable<Awaited<ReturnType<typeof getRideMeta>>>,
): Promise<{ screen: string; data: Record<string, unknown> }> {
  const walletInfo = await getWalletInfo(userId);

  return {
    screen: 'PAYMENT',
    data: buildPaymentData({
      fareNgn: meta.offerNgn,
      ...walletInfo,
    }),
  };
}

// ── RIDE_SETUP init — build setup screen from pending location data ─────

async function handleRideSetupInit(
  userId: string,
  deps: WhatsappFlowEndpointDeps,
): Promise<{ screen: string; data: Record<string, unknown> }> {
  const existingRideId = await getActiveRide(deps.redisClient, userId);
  if (existingRideId) {
    return await resolveScreen(existingRideId, userId, deps);
  }

  const pendingLocation = await getPendingLocation(deps.redisClient, userId);

  return {
    screen: 'RIDE_SETUP',
    data: buildRideSetupData({
      pickupAddress: pendingLocation?.address ?? '',
      destinationAddress: '',
    }),
  };
}

// ── Estimate fare — geocode + plan route, hand off to FARE_CONFIRM ──────

async function handleEstimateFare(
  userId: string,
  data: Record<string, unknown>,
  deps: WhatsappFlowEndpointDeps,
): Promise<{ screen: string; data: Record<string, unknown> }> {
  const pickupAddress = (data.pickup_address as string)?.trim();
  const destinationAddress = (data.destination_address as string)?.trim();

  if (!pickupAddress || pickupAddress.length < 3) {
    return {
      screen: 'RIDE_SETUP',
      data: buildRideSetupData({
        pickupAddress: pickupAddress ?? '',
        destinationAddress: destinationAddress ?? '',
        error: 'Enter a more specific pickup (street, landmark, bus stop)',
      }),
    };
  }

  if (!destinationAddress || destinationAddress.length < 3) {
    return {
      screen: 'RIDE_SETUP',
      data: buildRideSetupData({
        pickupAddress,
        destinationAddress: destinationAddress ?? '',
        error: 'Enter a more specific destination (street, landmark, bus stop)',
      }),
    };
  }

  const existingRide = await getActiveRide(deps.redisClient, userId);
  if (existingRide) {
    return {
      screen: 'RIDE_SETUP',
      data: buildRideSetupData({
        pickupAddress,
        destinationAddress,
        error: "You have an active ride. Say 'cancel ride' on WhatsApp first.",
      }),
    };
  }

  // A location pin shared in chat pre-fills pickup; only trust its coordinates
  // when the rider kept that exact address.
  const pendingLocation = await getPendingLocation(deps.redisClient, userId);
  let pickupGeo: { lat: number; lng: number; formattedAddress: string } | null = null;
  if (pendingLocation && pendingLocation.address === pickupAddress) {
    pickupGeo = { lat: pendingLocation.lat, lng: pendingLocation.lng, formattedAddress: pendingLocation.address };
    await clearPendingLocation(deps.redisClient, userId);
  } else {
    pickupGeo = await geocodeAddress(deps.googleMapsApiKey, `${pickupAddress}, Lagos, Nigeria`);
  }

  if (!pickupGeo) {
    return {
      screen: 'RIDE_SETUP',
      data: buildRideSetupData({
        pickupAddress,
        destinationAddress,
        error: `Could not find "${pickupAddress}". Try a landmark, bus stop, or street name.`,
      }),
    };
  }

  const destGeo = await geocodeAddress(deps.googleMapsApiKey, `${destinationAddress}, Lagos, Nigeria`);
  if (!destGeo) {
    return {
      screen: 'RIDE_SETUP',
      data: buildRideSetupData({
        pickupAddress,
        destinationAddress,
        error: `Could not find "${destinationAddress}". Try a landmark, bus stop, or street name.`,
      }),
    };
  }

  let plannedRoute: Awaited<ReturnType<typeof deps.routePlanner.planRoute>>;
  try {
    plannedRoute = await deps.routePlanner.planRoute({
      origin: pickupGeo,
      destination: destGeo,
    });
  } catch (error) {
    console.warn('[whatsapp-flow] route planning failed', {
      pickup: pickupGeo.formattedAddress,
      destination: destGeo.formattedAddress,
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      screen: 'RIDE_SETUP',
      data: buildRideSetupData({
        pickupAddress,
        destinationAddress,
        error: 'Could not find a driving route between those two points. Please check the addresses.',
      }),
    };
  }

  await storeFlowEstimate(deps.redisClient, userId, {
    pickupAddress: pickupGeo.formattedAddress,
    pickupLat: pickupGeo.lat,
    pickupLng: pickupGeo.lng,
    destinationAddress: destGeo.formattedAddress,
    destinationLat: destGeo.lat,
    destinationLng: destGeo.lng,
    distanceKm: plannedRoute.distanceKm,
    durationSeconds: plannedRoute.durationSeconds,
    suggestedFareNgn: plannedRoute.suggestedFareNgn,
    minOfferNgn: plannedRoute.minOfferNgn,
    ratePerKmNgn: plannedRoute.ratePerKmNgn,
    geometry: plannedRoute.geometry,
  });

  return {
    screen: 'FARE_CONFIRM',
    data: buildFareConfirmData({
      pickupAddress: pickupGeo.formattedAddress,
      destinationAddress: destGeo.formattedAddress,
      suggestedFareNgn: plannedRoute.suggestedFareNgn,
      distanceKm: plannedRoute.distanceKm,
      durationSeconds: plannedRoute.durationSeconds,
    }),
  };
}

// ── Find drivers — create the ride from the confirmed estimate ──────────

async function handleFindDrivers(
  userId: string,
  data: Record<string, unknown>,
  deps: WhatsappFlowEndpointDeps,
): Promise<{ screen: string; data: Record<string, unknown> }> {
  const pickupAddress = (data.pickup_address as string)?.trim();
  const destinationAddress = (data.destination_address as string)?.trim();
  const offerAmount = Number(data.offer_amount);
  const paymentMethod = 'WALLET' as const;

  // Meta's routing model is forward-only, so a failure here cannot send the
  // rider back to RIDE_SETUP — redisplay FARE_CONFIRM or exit via SUCCESS.
  if (!pickupAddress || !destinationAddress) {
    return {
      screen: 'SUCCESS',
      data: buildNotifyExitData("Something went wrong with that booking. Send 'hi' to start again."),
    };
  }

  const existingRide = await getActiveRide(deps.redisClient, userId);
  if (existingRide) {
    return {
      screen: 'SUCCESS',
      data: buildNotifyExitData("You already have an active ride. Say 'cancel ride' in the chat first if you want to rebook."),
    };
  }

  // Reuse the geocode + route from the estimate step; recompute only when the
  // cached estimate expired or no longer matches the addresses on screen.
  let route: FlowEstimate | null = await getFlowEstimate(deps.redisClient, userId);
  if (route && (route.pickupAddress !== pickupAddress || route.destinationAddress !== destinationAddress)) {
    route = null;
  }

  if (!route) {
    const pickupGeo = await geocodeAddress(deps.googleMapsApiKey, `${pickupAddress}, Lagos, Nigeria`);
    const destGeo = pickupGeo
      ? await geocodeAddress(deps.googleMapsApiKey, `${destinationAddress}, Lagos, Nigeria`)
      : null;
    if (!pickupGeo || !destGeo) {
      return {
        screen: 'SUCCESS',
        data: buildNotifyExitData("Your fare estimate expired and we couldn't confirm the route. Send 'hi' to start again."),
      };
    }

    let plannedRoute: Awaited<ReturnType<typeof deps.routePlanner.planRoute>>;
    try {
      plannedRoute = await deps.routePlanner.planRoute({
        origin: pickupGeo,
        destination: destGeo,
      });
    } catch (error) {
      console.warn('[whatsapp-flow] route planning failed', {
        pickup: pickupGeo.formattedAddress,
        destination: destGeo.formattedAddress,
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        screen: 'SUCCESS',
        data: buildNotifyExitData("We couldn't map a driving route for that trip. Send 'hi' to try again."),
      };
    }

    route = {
      pickupAddress: pickupGeo.formattedAddress,
      pickupLat: pickupGeo.lat,
      pickupLng: pickupGeo.lng,
      destinationAddress: destGeo.formattedAddress,
      destinationLat: destGeo.lat,
      destinationLng: destGeo.lng,
      distanceKm: plannedRoute.distanceKm,
      durationSeconds: plannedRoute.durationSeconds,
      suggestedFareNgn: plannedRoute.suggestedFareNgn,
      minOfferNgn: plannedRoute.minOfferNgn,
      ratePerKmNgn: plannedRoute.ratePerKmNgn,
      geometry: plannedRoute.geometry,
    };
  }

  const suggestedFareNgn = route.suggestedFareNgn;
  const riderOfferNgn = offerAmount > 0 ? offerAmount : suggestedFareNgn;
  const validation = validateRiderOffer(riderOfferNgn, suggestedFareNgn);
  if (!validation.valid) {
    return {
      screen: 'FARE_CONFIRM',
      data: buildFareConfirmData({
        pickupAddress: route.pickupAddress,
        destinationAddress: route.destinationAddress,
        suggestedFareNgn,
        distanceKm: route.distanceKm,
        durationSeconds: route.durationSeconds,
        error: validation.reason ?? 'That offer is too low. Try again.',
      }),
    };
  }
  const finalOffer = riderOfferNgn;

  const rideId = randomUUID();
  const phone = await lookupPhoneByUserId(deps.redisClient, userId) ?? '';

  const event = RideRequestedEvent.parse({
    eventType: 'RIDE_REQUESTED',
    rideId,
    riderId: userId,
    pickup: { lat: route.pickupLat, lng: route.pickupLng, address: route.pickupAddress },
    destination: { lat: route.destinationLat, lng: route.destinationLng, address: route.destinationAddress },
    stops: [],
    plannedDistanceKm: route.distanceKm,
    plannedDurationSeconds: route.durationSeconds,
    fareEstimateNgn: suggestedFareNgn,
    paymentMethod,
    riderOfferNgn: finalOffer,
    suggestedFareNgn,
    minOfferNgn: route.minOfferNgn,
    ratePerKmNgn: route.ratePerKmNgn,
    route: route.geometry,
    timestamp: new Date().toISOString(),
  });

  await deps.publisher.publishRideEvent(event);

  await storeWhatsappRide(deps.redisClient, rideId, {
    riderId: userId,
    phone,
    pickupAddress: route.pickupAddress,
    pickupLat: route.pickupLat,
    pickupLng: route.pickupLng,
    destinationAddress: route.destinationAddress,
    destinationLat: route.destinationLat,
    destinationLng: route.destinationLng,
    distanceKm: route.distanceKm,
    durationSeconds: route.durationSeconds,
    offerNgn: finalOffer,
    suggestedFareNgn,
    paymentMethod,
    createdAt: new Date().toISOString(),
  });
  await setActiveRide(deps.redisClient, userId, rideId);
  await clearFlowEstimate(deps.redisClient, userId);
  await clearPendingLocation(deps.redisClient, userId).catch(() => undefined);

  // Poll briefly — Meta shows a loading spinner while we wait
  const bids = await pollForBids(deps.redisClient, rideId, 0);

  if (bids.length > 0) {
    await setRideState(deps.redisClient, rideId, 'bidding');
    return {
      screen: 'BID_LIST',
      data: buildBidListData(
        {
          riderId: userId,
          phone,
          pickupAddress: route.pickupAddress,
          destinationAddress: route.destinationAddress,
          offerNgn: finalOffer,
          suggestedFareNgn,
          paymentMethod,
          createdAt: new Date().toISOString(),
        },
        bids,
      ),
    };
  }

  return {
    screen: 'SUCCESS',
    data: buildNotifyExitData("We're finding drivers near you! You'll get a notification as soon as someone is interested."),
  };
}

// ── HTTP handler ────────────────────────────────────────────────────────────

export async function handleWhatsappFlowEndpoint(
  req: IncomingMessage,
  res: ServerResponse,
  deps: WhatsappFlowEndpointDeps,
): Promise<void> {
  let decrypted: DecryptedFlowRequest;
  try {
    const rawBody = await readRawBody(req);
    const envelope = JSON.parse(rawBody.toString('utf8'));
    decrypted = decryptFlowRequest(envelope, deps.privateKeyPem);
  } catch (error) {
    // Meta's spec: a 421 tells WhatsApp our public key changed — it
    // re-fetches the key and re-encrypts. A 500 here leaves Meta stuck on
    // a stale cached key forever (exactly the health-check OAEP failure).
    console.warn('[whatsapp-flow] could not decrypt request — answering 421 so Meta refreshes the key', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.statusCode = 421;
    res.end();
    return;
  }

  try {
    const response = await handleFlowAction(decrypted.decryptedBody, deps);

    const encrypted = encryptFlowResponse(response, decrypted.aesKey, decrypted.iv);
    res.statusCode = 200;
    res.setHeader('content-type', 'text/plain');
    res.end(encrypted);
  } catch (error) {
    console.error('[whatsapp-flow] Endpoint error', error);
    sendJson(res, 500, { error: 'Internal error' });
  }
}
