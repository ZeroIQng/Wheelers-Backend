import type { IncomingMessage, ServerResponse } from "http";
import { randomUUID } from "crypto";
import {
  referralClient,
  ScheduledRidePaymentMethod,
  scheduledRideClient,
  rideClient,
} from "@wheleers/db";
import { GoogleMapsRoutePlanner } from "@wheleers/config";
import { Queue } from "bullmq";
import { authenticateHttpUser } from "./authenticate";
import { runIdempotentJsonRequest } from "./idempotency";
import { readJsonBody, sendJson } from "./utils";
import { getBoolean, getNumber, getRecord, getString, isRecord } from "../utils/object";
import {
  convertUsdtToRideDisplayAmount,
  type RidePricingDisplay,
  type RidePricingDisplayProvider,
} from "../pricing/display";
import { buildRideEstimatePricing } from "../pricing/ride-estimate";
import type { RedisClient } from "../redis/client";

interface RideRouteDeps {
  privyAppId: string;
  privyVerificationKey: string;
  routePlanner: GoogleMapsRoutePlanner;
}

interface RideHistoryRouteDeps {
  privyAppId: string;
  privyVerificationKey: string;
  ridePricingDisplayProvider: RidePricingDisplayProvider;
}

interface ScheduledRideRouteDeps {
  privyAppId: string;
  privyVerificationKey: string;
  routePlanner: GoogleMapsRoutePlanner;
  ridePricingDisplayProvider: RidePricingDisplayProvider;
  dispatcherQueue: Queue;
  leadTimeMs: number;
  redisClient: RedisClient;
}

type LatLngAddress = {
  lat: number;
  lng: number;
  address: string;
};

function buildScheduledRideJobId(scheduledRideId: string): string {
  return `scheduled-ride-${scheduledRideId}`;
}

function parseWaypoint(
  record: Record<string, unknown>,
  key: string,
): LatLngAddress {
  const value = getRecord(record, key);
  if (!value) {
    throw new Error(`Missing required field: ${key}`);
  }

  const lat = getNumber(value, "lat");
  const lng = getNumber(value, "lng");
  const address = getString(value, "address");

  if (lat === undefined || lng === undefined || !address) {
    throw new Error(`Invalid ${key} payload`);
  }

  return { lat, lng, address };
}

function parseStops(
  record: Record<string, unknown>,
  key: string,
): LatLngAddress[] {
  const value = record[key];
  if (value === undefined) {
    return [];
  }

  if (!Array.isArray(value)) {
    throw new Error(`Invalid ${key} payload`);
  }

  return value.map((item, index) => {
    if (!isRecord(item)) {
      throw new Error(`Invalid ${key}[${index}] payload`);
    }

    const lat = getNumber(item, "lat");
    const lng = getNumber(item, "lng");
    const address = getString(item, "address");

    if (lat === undefined || lng === undefined || !address) {
      throw new Error(`Invalid ${key}[${index}] payload`);
    }

    return { lat, lng, address };
  });
}

function parseLimit(value: string | null): number {
  if (!value) {
    return 20;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 20;
  }

  return Math.min(parsed, 50);
}

function decimalToNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  if (
    value &&
    typeof value === "object" &&
    "toString" in value &&
    typeof value.toString === "function"
  ) {
    const parsed = Number(value.toString());
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function resolveNetFareUsdt(params: {
  grossFareUsdt: number;
  grossFareNgn: number;
  discountNgn: number;
}): number {
  if (
    params.discountNgn <= 0 ||
    params.grossFareNgn <= 0 ||
    params.grossFareUsdt <= 0
  ) {
    return params.grossFareUsdt;
  }

  const discountRatio = Math.min(params.discountNgn / params.grossFareNgn, 1);
  return Math.max(0, Math.round(params.grossFareUsdt * (1 - discountRatio) * 1_000_000) / 1_000_000);
}

function parseScheduledFor(value: unknown): Date {
  if (typeof value !== "string") {
    throw new Error("scheduledFor must be an ISO datetime string");
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error("scheduledFor must be a valid ISO datetime string");
  }

  return parsed;
}

function normalizeScheduledPaymentMethod(
  value: unknown,
): ScheduledRidePaymentMethod {
  return value === "smart_account"
    ? ScheduledRidePaymentMethod.SMART_ACCOUNT
    : ScheduledRidePaymentMethod.WALLET_BALANCE;
}

function mapScheduledPaymentMethod(
  value: ScheduledRidePaymentMethod,
): "wallet_balance" | "smart_account" {
  return value === ScheduledRidePaymentMethod.SMART_ACCOUNT
    ? "smart_account"
    : "wallet_balance";
}

function mapScheduledRideItem(
  ride: Awaited<ReturnType<typeof scheduledRideClient.findByRider>>[number],
) {
  const fareEstimateUsdt = decimalToNumber(ride.fareEstimateUsdt);
  const pricing = buildRideEstimatePricing(ride.plannedDistanceKm ?? null);
  return {
    id: ride.id,
    status: ride.status,
    scheduledFor: ride.scheduledFor.toISOString(),
    paymentMethod: mapScheduledPaymentMethod(ride.paymentMethod),
    pickupAddress: ride.pickupAddress,
    destAddress: ride.destAddress,
    plannedDistanceKm: ride.plannedDistanceKm ?? null,
    plannedDurationSeconds: ride.plannedDurationSeconds ?? null,
    fareEstimateUsdt,
    fareEstimateNgn: pricing.fareEstimateNgn,
    pricingCurrency: pricing.pricingCurrency,
    pricingBreakdown: pricing.pricingBreakdown,
    requestedRideId: ride.requestedRideId ?? null,
    createdAt: ride.createdAt.toISOString(),
  };
}

export async function handleRideEstimateRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: RideRouteDeps,
): Promise<void> {
  try {
    await authenticateHttpUser(req, deps.privyAppId, deps.privyVerificationKey);

    const rawBody = await readJsonBody(req);
    if (!isRecord(rawBody)) {
      sendJson(res, 400, { error: "Body must be a JSON object" });
      return;
    }

    const pickup = parseWaypoint(rawBody, "pickup");
    const destination = parseWaypoint(rawBody, "destination");
    const stops = parseStops(rawBody, "stops");
    const plannedRoute = await deps.routePlanner.planRoute({
      origin: pickup,
      stops,
      destination,
    });

    sendJson(res, 200, {
      pickup,
      destination,
      stops,
      route: plannedRoute.geometry,
      plannedDistanceKm: plannedRoute.distanceKm,
      plannedDurationSeconds: plannedRoute.durationSeconds,
      fareEstimateUsdt: plannedRoute.fareEstimateUsdt,
      fareEstimateNgn: plannedRoute.ridePrice.tripPrice,
      pricingCurrency: "NGN",
      pricingBreakdown: plannedRoute.ridePrice,
    });
  } catch (error) {
    sendJson(res, 400, {
      error:
        error instanceof Error
          ? error.message
          : "Could not estimate ride route",
    });
  }
}

export async function handleRiderRideHistoryRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: RideHistoryRouteDeps,
  url: URL,
): Promise<void> {
  try {
    const user = await authenticateHttpUser(
      req,
      deps.privyAppId,
      deps.privyVerificationKey,
    );
    const limit = parseLimit(url.searchParams.get("limit"));
    const cursor = url.searchParams.get("cursor") ?? undefined;
    const rides = await rideClient.findRiderHistory(user.id, limit, cursor);
    const ridePricingDisplay =
      await deps.ridePricingDisplayProvider.getPricingDisplay();

    sendJson(res, 200, {
      items: rides.map((ride) => ({
        id: ride.id,
        status: ride.status,
        pickupAddress: ride.pickupAddress,
        destAddress: ride.destAddress,
        fareEstimateUsdt: decimalToNumber(ride.fareEstimateUsdt),
        fareEstimateNgn: convertUsdtToRideDisplayAmount(
          decimalToNumber(ride.fareEstimateUsdt),
          ridePricingDisplay,
        ),
        fareFinalUsdt: decimalToNumber(ride.fareFinalUsdt),
        fareFinalNgn: convertUsdtToRideDisplayAmount(
          decimalToNumber(ride.fareFinalUsdt),
          ridePricingDisplay,
        ),
        distanceKm: ride.distanceKm ?? null,
        durationSeconds: ride.durationSeconds ?? null,
        cancelReason: ride.cancelReason ?? null,
        matchedAt: ride.matchedAt?.toISOString() ?? null,
        startedAt: ride.startedAt?.toISOString() ?? null,
        completedAt: ride.completedAt?.toISOString() ?? null,
        cancelledAt: ride.cancelledAt?.toISOString() ?? null,
        createdAt: ride.createdAt.toISOString(),
        displayCurrency: ridePricingDisplay.displayCurrency,
        displayExchangeRate: ridePricingDisplay.displayExchangeRate,
      })),
      nextCursor:
        rides.length === limit ? (rides[rides.length - 1]?.id ?? null) : null,
    });
  } catch (error) {
    sendJson(res, 401, {
      error:
        error instanceof Error ? error.message : "Could not load ride history",
    });
  }
}

export async function handleCreateScheduledRideRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ScheduledRideRouteDeps,
): Promise<void> {
  try {
    const user = await authenticateHttpUser(
      req,
      deps.privyAppId,
      deps.privyVerificationKey,
    );
    if (!user.walletAddress) {
      sendJson(res, 400, { error: "Link a wallet before scheduling a ride." });
      return;
    }
    const riderWallet = user.walletAddress.toLowerCase();

    const rawBody = await readJsonBody(req);
    if (!isRecord(rawBody)) {
      sendJson(res, 400, { error: "Body must be a JSON object" });
      return;
    }

    const result = await runIdempotentJsonRequest({
      req,
      redisClient: deps.redisClient,
      userId: user.id,
      routeKey: "scheduled-rides:create",
      requestBody: rawBody,
      execute: async () => {
        const scheduledFor = parseScheduledFor(rawBody["scheduledFor"]);
        const pickup = parseWaypoint(rawBody, "pickup");
        const destination = parseWaypoint(rawBody, "destination");
        const stops = parseStops(rawBody, "stops");
        const plannedRoute = await deps.routePlanner.planRoute({
          origin: pickup,
          stops,
          destination,
        });
        const scheduledRideId = randomUUID();
        const useReferralCashback =
          getBoolean(rawBody, "useReferralCashback") ?? false;
        const requestedReferralCashbackNgn = getNumber(
          rawBody,
          "requestedReferralCashbackNgn",
        );
        let referralCashbackAppliedNgn = 0;
        let fareEstimateUsdt = plannedRoute.fareEstimateUsdt;

        if (useReferralCashback) {
          const reservation = await referralClient.reserveRideCashback({
            userId: user.id,
            rideId: scheduledRideId,
            fareNgn: plannedRoute.ridePrice.tripPrice,
            requestedAmountNgn: requestedReferralCashbackNgn,
          });
          referralCashbackAppliedNgn = reservation.reservedCashbackNgn;
          fareEstimateUsdt = resolveNetFareUsdt({
            grossFareUsdt: plannedRoute.fareEstimateUsdt,
            grossFareNgn: plannedRoute.ridePrice.tripPrice,
            discountNgn: referralCashbackAppliedNgn,
          });
        }

        const scheduledRide = await scheduledRideClient
          .create({
            id: scheduledRideId,
            riderId: user.id,
            riderWallet,
            scheduledFor,
            paymentMethod: normalizeScheduledPaymentMethod(rawBody["paymentMethod"]),
            pickupLat: pickup.lat,
            pickupLng: pickup.lng,
            pickupAddress: pickup.address,
            destLat: destination.lat,
            destLng: destination.lng,
            destAddress: destination.address,
            stops,
            plannedDistanceKm: plannedRoute.distanceKm,
            plannedDurationSeconds: plannedRoute.durationSeconds,
            fareEstimateUsdt,
          })
          .catch(async (error) => {
            if (referralCashbackAppliedNgn > 0) {
              await referralClient.releaseRideCashback(scheduledRideId).catch(
                (releaseError) =>
                  console.warn(
                    "[referrals] scheduled cashback release after create failure failed",
                    {
                      scheduledRideId,
                      error:
                        releaseError instanceof Error
                          ? releaseError.message
                          : String(releaseError),
                    },
                  ),
              );
            }
            throw error;
          });

        const delayMs = Math.max(
          0,
          scheduledRide.scheduledFor.getTime() - deps.leadTimeMs - Date.now(),
        );

        deps.dispatcherQueue
          .add(
            "dispatch",
            {
              scheduledRideId: scheduledRide.id,
              scheduledFor: scheduledRide.scheduledFor.toISOString(),
            },
            {
              delay: delayMs,
              jobId: buildScheduledRideJobId(scheduledRide.id),
            },
          )
          .catch((err) =>
            console.warn(
              `[api-gateway] BullMQ enqueue failed for ${scheduledRide.id} (recovery scanner will catch it):`,
              err,
            ),
          );

        return {
          statusCode: 201,
          body: {
            item: mapScheduledRideItem(scheduledRide),
            referralCashbackAppliedNgn,
            fareBeforeCashbackNgn: plannedRoute.ridePrice.tripPrice,
          },
        };
      },
    });

    sendJson(res, result.statusCode, result.body);
  } catch (error) {
    sendJson(res, 400, {
      error: error instanceof Error ? error.message : "Could not schedule ride",
    });
  }
}

export async function handleListScheduledRidesRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ScheduledRideRouteDeps,
  url: URL,
): Promise<void> {
  try {
    const user = await authenticateHttpUser(
      req,
      deps.privyAppId,
      deps.privyVerificationKey,
    );
    const limit = parseLimit(url.searchParams.get("limit"));
    const cursor = url.searchParams.get("cursor") ?? undefined;
    const rides = await scheduledRideClient.findByRider(user.id, limit, cursor);

    sendJson(res, 200, {
      items: rides.map((ride) => mapScheduledRideItem(ride)),
      nextCursor:
        rides.length === limit ? (rides[rides.length - 1]?.id ?? null) : null,
    });
  } catch (error) {
    sendJson(res, 401, {
      error:
        error instanceof Error
          ? error.message
          : "Could not load scheduled rides",
    });
  }
}

export async function handleCancelScheduledRideRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ScheduledRideRouteDeps,
  scheduledRideId: string,
): Promise<void> {
  try {
    const user = await authenticateHttpUser(
      req,
      deps.privyAppId,
      deps.privyVerificationKey,
    );
    const rawBody = await readJsonBody(req).catch(() => ({}));
    const reason =
      isRecord(rawBody) && typeof rawBody["reason"] === "string"
        ? rawBody["reason"]
        : undefined;
    const result = await scheduledRideClient.cancel(
      scheduledRideId,
      user.id,
      reason,
    );

    if (result.count === 0) {
      sendJson(res, 404, {
        error: "Scheduled ride not found or already closed.",
      });
      return;
    }

    deps.dispatcherQueue
      .remove(buildScheduledRideJobId(scheduledRideId))
      .catch((err) =>
        console.warn(
          `[api-gateway] could not remove BullMQ job for ${scheduledRideId}:`,
          err,
        ),
      );
    sendJson(res, 200, {
      cancelled: true,
      scheduledRideId,
    });
  } catch (error) {
    sendJson(res, 400, {
      error:
        error instanceof Error
          ? error.message
          : "Could not cancel scheduled ride",
    });
  }
}
