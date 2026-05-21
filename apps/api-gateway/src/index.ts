import { createServer, type ServerResponse } from "http";
import {
  buildTopicList,
  createConsumer,
  createProducer,
  ensureTopics,
  onShutdown,
  registerShutdownHandlers,
  TOPIC_PRESETS,
} from "@wheleers/kafka-client";
import {
  GoogleMapsRoutePlanner,
  loadWorkspaceEnv,
  validateGatewayEnv,
  validateSharedEnv,
} from "@wheleers/config";
import { TOPICS } from "@wheleers/kafka-schemas";
import { Queue } from "bullmq";
import IORedis from "ioredis";

import { handlePrivyAuthRoute } from "./http/auth.route";
import {
  handleGetCurrentProfileRoute,
  handleUpdateCurrentProfileRoute,
} from "./http/profile.route";
import {
  handleListNotificationsRoute,
  handleMarkNotificationsReadRoute,
  handleRegisterPushTokenRoute,
} from "./http/notification.route";
import {
  handleCancelScheduledRideRoute,
  handleCreateScheduledRideRoute,
  handleListScheduledRidesRoute,
  handleRideEstimateRoute,
  handleRiderRideHistoryRoute,
} from "./http/ride.route";
import {
  handleCancelGroupRideMatchRequestRoute,
  handleCompleteGroupRideFaceUploadRoute,
  handleCreateGroupRideFaceUploadUrlRoute,
  handleCreateGroupRideMatchRequestRoute,
  handleGetGroupRideMatchRequestRoute,
  handleListGroupRideMatchRequestsRoute,
} from "./http/group-ride.route";
import {
  handlePouchHealthRoute,
  handlePouchOfframpRoute,
  handlePouchOnrampRoute,
  handlePouchStatusRoute,
  handlePouchWebhookRoute,
} from "./http/pouch.route";
import {
  handleCreateWalletWithdrawalRoute,
  handleGetWalletWithdrawalRoute,
  handleListWithdrawalBankNetworksRoute,
  handleListWalletWithdrawalsRoute,
  handleVerifyWithdrawalBankAccountRoute,
  handleWalletOverviewRoute,
  handleWalletTransactionsRoute,
} from "./http/wallet.route";
import {
  handleSendPhoneOtpRoute,
  handleVerifyPhoneOtpRoute,
} from "./http/phone.route";
import { PouchClient } from "./http/pouch.client";
import { applyCorsHeaders, sendJson } from "./http/utils";
import { startGatewayKafkaConsumer } from "./kafka/consumer";
import { CoinGeckoRidePricingDisplayProvider } from "./pricing/display";
import { RedisClient } from "./redis/client";
import { asRawProducer, startOutboxPublisher } from "./outbox/outbox-publisher";
import { GatewayPublisher } from "./websocket/publisher";
import { SocketRegistry } from "./websocket/registry";
import { createGatewayWebSocketServer } from "./websocket/server";
import { GroupRideFaceStorage } from "./storage/group-ride-face-storage";

const SCHEDULED_RIDE_QUEUE = "wheleers-scheduled-rides";

function parseAllowedOrigins(raw: string): Set<string> {
  return new Set(
    raw
      .split(",")
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0),
  );
}

function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

function sendMethodNotAllowed(res: ServerResponse): void {
  sendJson(res, 405, { error: "Method not allowed" });
}

function buildPouchUserKycDefaults(env: {
  POUCH_FULL_NAME?: string;
  POUCH_PHONE?: string;
  POUCH_ADDRESS?: string;
  POUCH_DOB?: string;
  POUCH_NIN?: string;
  POUCH_BVN?: string;
  POUCH_TEST_EMAIL?: string;
}): Record<string, string> | undefined {
  const entries = Object.entries({
    FULL_NAME: env.POUCH_FULL_NAME,
    PHONE: env.POUCH_PHONE,
    ADDRESS: env.POUCH_ADDRESS,
    DOB: normalizePouchDob(env.POUCH_DOB),
    NIN: env.POUCH_NIN,
    BVN: env.POUCH_BVN,
    EMAIL: env.POUCH_TEST_EMAIL,
  }).filter(([, value]) => typeof value === "string" && value.trim().length > 0);

  if (entries.length === 0) {
    return undefined;
  }

  return Object.fromEntries(entries) as Record<string, string>;
}

function normalizePouchDob(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  const trimmed = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return trimmed;
  }

  const slashMatch = trimmed.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (slashMatch) {
    const [, month, day, year] = slashMatch;
    return `${year}-${month}-${day}`;
  }

  return trimmed;
}

async function bootstrap(): Promise<void> {
  loadWorkspaceEnv();

  process.env["NODE_ENV"] ??= "development";
  process.env["KAFKA_CLIENT_ID"] ??= "api-gateway";
  process.env["KAFKA_BROKERS"] ??= "localhost:29092";
  process.env["DATABASE_URL"] ??=
    "postgresql://postgres:postgres@localhost:5432/wheelers";
  process.env["REDIS_URL"] ??= "redis://localhost:6379";

  const sharedEnv = validateSharedEnv();
  const gatewayEnv = validateGatewayEnv();

  // BullMQ dispatcher queue.
  // Gateway only enqueues scheduled rides.
  // Ride-service owns the worker that dispatches them.
  const dispatcherRedis = new IORedis(sharedEnv.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });

  const dispatcherQueue = new Queue(SCHEDULED_RIDE_QUEUE, {
    connection: dispatcherRedis,
    defaultJobOptions: {
      attempts: 3,
      backoff: {
        type: "exponential",
        delay: 5_000,
      },
      removeOnComplete: {
        count: 200,
      },
      removeOnFail: {
        count: 500,
      },
    },
  });

  const leadTimeMs = gatewayEnv.SCHEDULED_RIDE_DISPATCH_LEAD_TIME_S * 1_000;

  registerShutdownHandlers("api-gateway");

  await ensureTopics(
    buildTopicList([
      [TOPICS.USER_EVENTS, TOPIC_PRESETS.STANDARD],
      [TOPICS.DRIVER_EVENTS, TOPIC_PRESETS.STANDARD],
      [TOPICS.RIDE_EVENTS, TOPIC_PRESETS.STANDARD],
      [TOPICS.PAYMENT_EVENTS, TOPIC_PRESETS.STANDARD],
      [TOPICS.WALLET_EVENTS, TOPIC_PRESETS.STANDARD],
      [TOPICS.NOTIFICATION_EVENTS, TOPIC_PRESETS.LOW_VOLUME],
      [TOPICS.COMPLIANCE_EVENTS, TOPIC_PRESETS.LOW_VOLUME],
      [TOPICS.GPS_STREAM, TOPIC_PRESETS.GPS],
      [TOPICS.GPS_PROCESSED, TOPIC_PRESETS.GPS],
    ]),
  );

  const producer = await createProducer({
    serviceId: sharedEnv.KAFKA_CLIENT_ID,
  });

  const consumer = await createConsumer({
    groupId: sharedEnv.KAFKA_CLIENT_ID,
  });

  const redisCommandClient = new RedisClient(sharedEnv.REDIS_URL);
  const redisSubscriberClient = new RedisClient(sharedEnv.REDIS_URL);

  await redisCommandClient.connect();
  await redisSubscriberClient.connect();

  const publisher = new GatewayPublisher(producer);

  const pouchClient = new PouchClient(
    gatewayEnv.POUCH_BASE_URL,
    gatewayEnv.POUCH_API_KEY,
  );

  const routePlanner = new GoogleMapsRoutePlanner(
    gatewayEnv.GOOGLE_MAPS_BASE_URL,
    gatewayEnv.GOOGLE_MAPS_API_KEY,
  );

  const groupRideFaceStorage =
    gatewayEnv.AWS_REGION && gatewayEnv.GROUP_RIDE_FACE_S3_BUCKET
      ? new GroupRideFaceStorage({
          region: gatewayEnv.AWS_REGION,
          bucket: gatewayEnv.GROUP_RIDE_FACE_S3_BUCKET,
          prefix: gatewayEnv.GROUP_RIDE_FACE_S3_PREFIX,
          uploadUrlTtlSeconds: gatewayEnv.GROUP_RIDE_FACE_UPLOAD_URL_TTL_S,
        })
      : undefined;

  const ridePricingDisplayProvider = new CoinGeckoRidePricingDisplayProvider(
    gatewayEnv.COINGECKO_BASE_URL,
    gatewayEnv.RIDE_DISPLAY_RATE_TTL_MS,
    gatewayEnv.RIDE_DISPLAY_NGN_PER_USDT_FALLBACK,
  );

  const registry = new SocketRegistry({
    instanceId: `${sharedEnv.KAFKA_CLIENT_ID}-${process.pid}-${Math.random()
      .toString(16)
      .slice(2, 8)}`,
    commandRedis: redisCommandClient,
    subscriberRedis: redisSubscriberClient,
  });

  await registry.start();

  const allowedOrigins = parseAllowedOrigins(gatewayEnv.CORS_ORIGINS);
  const pouchUserKycDefaults = buildPouchUserKycDefaults(gatewayEnv);

  const scheduledRideDeps = {
    privyAppId: gatewayEnv.PRIVY_APP_ID,
    privyVerificationKey: gatewayEnv.PRIVY_VERIFICATION_KEY,
    routePlanner,
    ridePricingDisplayProvider,
    dispatcherQueue,
    leadTimeMs,
  };

  const groupRideDeps = {
    privyAppId: gatewayEnv.PRIVY_APP_ID,
    privyVerificationKey: gatewayEnv.PRIVY_VERIFICATION_KEY,
    routePlanner,
    publisher,
    faceStorage: groupRideFaceStorage,
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");

    applyCorsHeaders(req, res, allowedOrigins);

    if (req.method === "OPTIONS") {
      res.statusCode = 204;
      res.end();
      return;
    }

    if (req.method === "GET" && url.pathname === "/health") {
      sendJson(res, 200, {
        status: "ok",
        service: "api-gateway",
        timestamp: new Date().toISOString(),
      });
      return;
    }

    if (url.pathname === "/auth/privy") {
      if (req.method !== "POST") {
        sendMethodNotAllowed(res);
        return;
      }

      await handlePrivyAuthRoute(req, res, {
        privyAppId: gatewayEnv.PRIVY_APP_ID,
        privyVerificationKey: gatewayEnv.PRIVY_VERIFICATION_KEY,
        publisher,
      });

      return;
    }

    if (url.pathname === "/auth/me") {
      if (req.method !== "GET") {
        sendMethodNotAllowed(res);
        return;
      }

      await handleGetCurrentProfileRoute(req, res, {
        privyAppId: gatewayEnv.PRIVY_APP_ID,
        privyVerificationKey: gatewayEnv.PRIVY_VERIFICATION_KEY,
      });
      return;
    }

    if (url.pathname === "/auth/profile") {
      if (req.method !== "PUT") {
        sendMethodNotAllowed(res);
        return;
      }

      await handleUpdateCurrentProfileRoute(req, res, {
        privyAppId: gatewayEnv.PRIVY_APP_ID,
        privyVerificationKey: gatewayEnv.PRIVY_VERIFICATION_KEY,
      });
      return;
    }

    if (url.pathname === "/notifications") {
      if (req.method === "GET") {
        await handleListNotificationsRoute(req, res, {
          privyAppId: gatewayEnv.PRIVY_APP_ID,
          privyVerificationKey: gatewayEnv.PRIVY_VERIFICATION_KEY,
        }, url);
        return;
      }

      sendMethodNotAllowed(res);
      return;
    }

    if (url.pathname === "/notifications/read") {
      if (req.method !== "POST") {
        sendMethodNotAllowed(res);
        return;
      }

      await handleMarkNotificationsReadRoute(req, res, {
        privyAppId: gatewayEnv.PRIVY_APP_ID,
        privyVerificationKey: gatewayEnv.PRIVY_VERIFICATION_KEY,
      });
      return;
    }

    if (url.pathname === "/notifications/device") {
      if (req.method !== "POST") {
        sendMethodNotAllowed(res);
        return;
      }

      await handleRegisterPushTokenRoute(req, res, {
        privyAppId: gatewayEnv.PRIVY_APP_ID,
        privyVerificationKey: gatewayEnv.PRIVY_VERIFICATION_KEY,
      });
      return;
    }

    if (url.pathname === "/auth/phone/send-otp") {
      if (req.method !== "POST") {
        sendMethodNotAllowed(res);
        return;
      }

      await handleSendPhoneOtpRoute(req, res, {
        privyAppId: gatewayEnv.PRIVY_APP_ID,
        privyVerificationKey: gatewayEnv.PRIVY_VERIFICATION_KEY,
        redisClient: redisCommandClient,
        twilioAccountSid: gatewayEnv.TWILIO_ACCOUNT_SID,
        twilioAuthToken: gatewayEnv.TWILIO_AUTH_TOKEN,
        twilioFromNumber: gatewayEnv.TWILIO_FROM_NUMBER,
        twilioOtpTtlSeconds: gatewayEnv.TWILIO_OTP_TTL_SECONDS,
      });

      return;
    }

    if (url.pathname === "/auth/phone/verify-otp") {
      if (req.method !== "POST") {
        sendMethodNotAllowed(res);
        return;
      }

      await handleVerifyPhoneOtpRoute(req, res, {
        privyAppId: gatewayEnv.PRIVY_APP_ID,
        privyVerificationKey: gatewayEnv.PRIVY_VERIFICATION_KEY,
        redisClient: redisCommandClient,
        twilioAccountSid: gatewayEnv.TWILIO_ACCOUNT_SID,
        twilioAuthToken: gatewayEnv.TWILIO_AUTH_TOKEN,
        twilioFromNumber: gatewayEnv.TWILIO_FROM_NUMBER,
        twilioOtpTtlSeconds: gatewayEnv.TWILIO_OTP_TTL_SECONDS,
      });

      return;
    }

    if (url.pathname === "/rides/estimate") {
      if (req.method !== "POST") {
        sendMethodNotAllowed(res);
        return;
      }

      await handleRideEstimateRoute(req, res, {
        privyAppId: gatewayEnv.PRIVY_APP_ID,
        privyVerificationKey: gatewayEnv.PRIVY_VERIFICATION_KEY,
        routePlanner,
      });

      return;
    }

    if (url.pathname === "/rides/history") {
      if (req.method !== "GET") {
        sendMethodNotAllowed(res);
        return;
      }

      await handleRiderRideHistoryRoute(
        req,
        res,
        {
          privyAppId: gatewayEnv.PRIVY_APP_ID,
          privyVerificationKey: gatewayEnv.PRIVY_VERIFICATION_KEY,
          ridePricingDisplayProvider,
        },
        url,
      );

      return;
    }

    if (url.pathname === "/scheduled-rides") {
      if (req.method === "GET") {
        await handleListScheduledRidesRoute(req, res, scheduledRideDeps, url);
        return;
      }

      if (req.method === "POST") {
        await handleCreateScheduledRideRoute(req, res, scheduledRideDeps);
        return;
      }

      sendMethodNotAllowed(res);
      return;
    }

    if (url.pathname.startsWith("/scheduled-rides/")) {
      const scheduledRideMatch = url.pathname.match(
        /^\/scheduled-rides\/([^/]+)\/cancel$/,
      );

      if (!scheduledRideMatch) {
        sendJson(res, 404, { error: "Not found" });
        return;
      }

      if (req.method !== "POST") {
        sendMethodNotAllowed(res);
        return;
      }

      await handleCancelScheduledRideRoute(
        req,
        res,
        scheduledRideDeps,
        decodeURIComponent(scheduledRideMatch[1]),
      );

      return;
    }

    if (url.pathname === "/group-rides/requests") {
      if (req.method === "GET") {
        await handleListGroupRideMatchRequestsRoute(req, res, groupRideDeps, url);
        return;
      }

      if (req.method === "POST") {
        await handleCreateGroupRideMatchRequestRoute(req, res, groupRideDeps);
        return;
      }

      sendMethodNotAllowed(res);
      return;
    }

    if (url.pathname.startsWith("/group-rides/requests/")) {
      const uploadUrlMatch = url.pathname.match(
        /^\/group-rides\/requests\/([^/]+)\/face-upload-url$/,
      );
      if (uploadUrlMatch) {
        if (req.method !== "POST") {
          sendMethodNotAllowed(res);
          return;
        }

        await handleCreateGroupRideFaceUploadUrlRoute(
          req,
          res,
          groupRideDeps,
          decodeURIComponent(uploadUrlMatch[1]),
        );
        return;
      }

      const completeUploadMatch = url.pathname.match(
        /^\/group-rides\/requests\/([^/]+)\/face-upload-complete$/,
      );
      if (completeUploadMatch) {
        if (req.method !== "POST") {
          sendMethodNotAllowed(res);
          return;
        }

        await handleCompleteGroupRideFaceUploadRoute(
          req,
          res,
          groupRideDeps,
          decodeURIComponent(completeUploadMatch[1]),
        );
        return;
      }

      const cancelMatch = url.pathname.match(
        /^\/group-rides\/requests\/([^/]+)\/cancel$/,
      );
      if (cancelMatch) {
        if (req.method !== "POST") {
          sendMethodNotAllowed(res);
          return;
        }

        await handleCancelGroupRideMatchRequestRoute(
          req,
          res,
          groupRideDeps,
          decodeURIComponent(cancelMatch[1]),
        );
        return;
      }

      const requestMatch = url.pathname.match(/^\/group-rides\/requests\/([^/]+)$/);
      if (!requestMatch) {
        sendJson(res, 404, { error: "Not found" });
        return;
      }

      if (req.method === "GET") {
        await handleGetGroupRideMatchRequestRoute(
          req,
          res,
          groupRideDeps,
          decodeURIComponent(requestMatch[1]),
        );
        return;
      }

      sendMethodNotAllowed(res);
      return;
    }

    if (url.pathname === "/payments/pouch/health") {
      if (req.method !== "GET") {
        sendMethodNotAllowed(res);
        return;
      }

      await handlePouchHealthRoute(req, res, {
        pouchClient,
      });

      return;
    }

    if (url.pathname === "/webhooks/pouchpay") {
      if (req.method !== "POST") {
        sendMethodNotAllowed(res);
        return;
      }

      await handlePouchWebhookRoute(req, res, {
        publisher,
        webhookSecret: gatewayEnv.POUCH_WEBHOOK_SECRET,
      });

      return;
    }

    if (url.pathname === "/payments/pouch/onramp") {
      if (req.method !== "POST") {
        sendMethodNotAllowed(res);
        return;
      }

      await handlePouchOnrampRoute(req, res, {
        privyAppId: gatewayEnv.PRIVY_APP_ID,
        privyVerificationKey: gatewayEnv.PRIVY_VERIFICATION_KEY,
        pouchClient,
        publisher,
        ridePricingDisplayProvider,
        defaults: {
          providerId: gatewayEnv.POUCH_PROVIDER_ID,
          countryCode: gatewayEnv.POUCH_COUNTRY_CODE,
          currency: gatewayEnv.POUCH_FIAT_CURRENCY,
          cryptoCurrency: gatewayEnv.POUCH_CRYPTO_CURRENCY,
          cryptoNetwork: gatewayEnv.POUCH_CRYPTO_NETWORK,
          chain: gatewayEnv.POUCH_CHAIN,
          masterWalletAddress: gatewayEnv.POUCH_MASTER_WALLET_ADDRESS,
          walletTag: gatewayEnv.POUCH_WALLET_TAG,
          testEmail: gatewayEnv.POUCH_TEST_EMAIL,
          userKycDefaults: pouchUserKycDefaults,
        },
      });

      return;
    }

    if (url.pathname === "/payments/pouch/offramp") {
      if (req.method !== "POST") {
        sendMethodNotAllowed(res);
        return;
      }

      await handlePouchOfframpRoute(req, res, {
        privyAppId: gatewayEnv.PRIVY_APP_ID,
        privyVerificationKey: gatewayEnv.PRIVY_VERIFICATION_KEY,
        pouchClient,
        publisher,
        ridePricingDisplayProvider,
        defaults: {
          providerId: gatewayEnv.POUCH_PROVIDER_ID,
          countryCode: gatewayEnv.POUCH_COUNTRY_CODE,
          currency: gatewayEnv.POUCH_FIAT_CURRENCY,
          cryptoCurrency: gatewayEnv.POUCH_CRYPTO_CURRENCY,
          cryptoNetwork: gatewayEnv.POUCH_CRYPTO_NETWORK,
          chain: gatewayEnv.POUCH_CHAIN,
          masterWalletAddress: gatewayEnv.POUCH_MASTER_WALLET_ADDRESS,
          walletTag: gatewayEnv.POUCH_WALLET_TAG,
          testEmail: gatewayEnv.POUCH_TEST_EMAIL,
          userKycDefaults: pouchUserKycDefaults,
        },
      });

      return;
    }

    if (url.pathname.startsWith("/payments/pouch/status/")) {
      const statusMatch = url.pathname.match(/^\/payments\/pouch\/status\/([^/]+)$/);

      if (!statusMatch) {
        sendJson(res, 404, { error: "Not found" });
        return;
      }

      if (req.method !== "GET") {
        sendMethodNotAllowed(res);
        return;
      }

      const requestedType =
        url.searchParams.get("type")?.toUpperCase() === "ONRAMP" ||
        url.searchParams.get("type")?.toUpperCase() === "OFFRAMP"
          ? (url.searchParams.get("type")?.toUpperCase() as "ONRAMP" | "OFFRAMP")
          : undefined;

      await handlePouchStatusRoute(
        req,
        res,
        {
          privyAppId: gatewayEnv.PRIVY_APP_ID,
          privyVerificationKey: gatewayEnv.PRIVY_VERIFICATION_KEY,
          pouchClient,
          publisher,
          ridePricingDisplayProvider,
          defaults: {
            providerId: gatewayEnv.POUCH_PROVIDER_ID,
            countryCode: gatewayEnv.POUCH_COUNTRY_CODE,
            currency: gatewayEnv.POUCH_FIAT_CURRENCY,
            cryptoCurrency: gatewayEnv.POUCH_CRYPTO_CURRENCY,
            cryptoNetwork: gatewayEnv.POUCH_CRYPTO_NETWORK,
            chain: gatewayEnv.POUCH_CHAIN,
            masterWalletAddress: gatewayEnv.POUCH_MASTER_WALLET_ADDRESS,
            walletTag: gatewayEnv.POUCH_WALLET_TAG,
            testEmail: gatewayEnv.POUCH_TEST_EMAIL,
            userKycDefaults: pouchUserKycDefaults,
          },
        },
        decodeURIComponent(statusMatch[1]),
        requestedType,
      );

      return;
    }

    if (url.pathname === "/wallet/overview") {
      if (req.method !== "GET") {
        sendMethodNotAllowed(res);
        return;
      }

      await handleWalletOverviewRoute(req, res, {
        privyAppId: gatewayEnv.PRIVY_APP_ID,
        privyVerificationKey: gatewayEnv.PRIVY_VERIFICATION_KEY,
        ridePricingDisplayProvider,
        pouchClient,
        publisher,
        defaults: {
          providerId: gatewayEnv.POUCH_PROVIDER_ID,
          countryCode: gatewayEnv.POUCH_COUNTRY_CODE,
          currency: gatewayEnv.POUCH_FIAT_CURRENCY,
          cryptoCurrency: gatewayEnv.POUCH_CRYPTO_CURRENCY,
          cryptoNetwork: gatewayEnv.POUCH_CRYPTO_NETWORK,
          chain: gatewayEnv.POUCH_CHAIN,
          masterWalletAddress: gatewayEnv.POUCH_MASTER_WALLET_ADDRESS,
          stellarNetwork: gatewayEnv.STELLAR_NETWORK,
          testEmail: gatewayEnv.POUCH_TEST_EMAIL,
          userKycDefaults: pouchUserKycDefaults,
        },
      });

      return;
    }

    if (url.pathname === "/wallet/transactions") {
      if (req.method !== "GET") {
        sendMethodNotAllowed(res);
        return;
      }

      await handleWalletTransactionsRoute(
        req,
        res,
        {
          privyAppId: gatewayEnv.PRIVY_APP_ID,
          privyVerificationKey: gatewayEnv.PRIVY_VERIFICATION_KEY,
          ridePricingDisplayProvider,
          pouchClient,
          publisher,
          redisClient: redisCommandClient,
          defaults: {
            providerId: gatewayEnv.POUCH_PROVIDER_ID,
            countryCode: gatewayEnv.POUCH_COUNTRY_CODE,
            currency: gatewayEnv.POUCH_FIAT_CURRENCY,
            cryptoCurrency: gatewayEnv.POUCH_CRYPTO_CURRENCY,
            cryptoNetwork: gatewayEnv.POUCH_CRYPTO_NETWORK,
            chain: gatewayEnv.POUCH_CHAIN,
            masterWalletAddress: gatewayEnv.POUCH_MASTER_WALLET_ADDRESS,
            stellarNetwork: gatewayEnv.STELLAR_NETWORK,
            testEmail: gatewayEnv.POUCH_TEST_EMAIL,
            userKycDefaults: pouchUserKycDefaults,
          },
        },
        url,
      );

      return;
    }

    if (url.pathname === "/wallet/withdrawals/bank-networks") {
      if (req.method !== "GET") {
        sendMethodNotAllowed(res);
        return;
      }

      await handleListWithdrawalBankNetworksRoute(
        req,
        res,
        {
          privyAppId: gatewayEnv.PRIVY_APP_ID,
          privyVerificationKey: gatewayEnv.PRIVY_VERIFICATION_KEY,
          ridePricingDisplayProvider,
          pouchClient,
          publisher,
          redisClient: redisCommandClient,
          defaults: {
            providerId: gatewayEnv.POUCH_PROVIDER_ID,
            countryCode: gatewayEnv.POUCH_COUNTRY_CODE,
            currency: gatewayEnv.POUCH_FIAT_CURRENCY,
            cryptoCurrency: gatewayEnv.POUCH_CRYPTO_CURRENCY,
            cryptoNetwork: gatewayEnv.POUCH_CRYPTO_NETWORK,
            chain: gatewayEnv.POUCH_CHAIN,
            masterWalletAddress: gatewayEnv.POUCH_MASTER_WALLET_ADDRESS,
            stellarNetwork: gatewayEnv.STELLAR_NETWORK,
            testEmail: gatewayEnv.POUCH_TEST_EMAIL,
            userKycDefaults: pouchUserKycDefaults,
          },
        },
        url,
      );
      return;
    }

    if (url.pathname === "/wallet/withdrawals/verify-bank-account") {
      if (req.method !== "POST") {
        sendMethodNotAllowed(res);
        return;
      }

      await handleVerifyWithdrawalBankAccountRoute(req, res, {
        privyAppId: gatewayEnv.PRIVY_APP_ID,
        privyVerificationKey: gatewayEnv.PRIVY_VERIFICATION_KEY,
        ridePricingDisplayProvider,
        pouchClient,
        publisher,
        redisClient: redisCommandClient,
        defaults: {
          providerId: gatewayEnv.POUCH_PROVIDER_ID,
          countryCode: gatewayEnv.POUCH_COUNTRY_CODE,
          currency: gatewayEnv.POUCH_FIAT_CURRENCY,
          cryptoCurrency: gatewayEnv.POUCH_CRYPTO_CURRENCY,
          cryptoNetwork: gatewayEnv.POUCH_CRYPTO_NETWORK,
          chain: gatewayEnv.POUCH_CHAIN,
          masterWalletAddress: gatewayEnv.POUCH_MASTER_WALLET_ADDRESS,
          stellarNetwork: gatewayEnv.STELLAR_NETWORK,
          testEmail: gatewayEnv.POUCH_TEST_EMAIL,
          userKycDefaults: pouchUserKycDefaults,
        },
      });
      return;
    }

    if (url.pathname === "/wallet/withdrawals") {
      if (req.method === "GET") {
        await handleListWalletWithdrawalsRoute(
          req,
          res,
          {
            privyAppId: gatewayEnv.PRIVY_APP_ID,
            privyVerificationKey: gatewayEnv.PRIVY_VERIFICATION_KEY,
            ridePricingDisplayProvider,
            pouchClient,
            publisher,
            defaults: {
              providerId: gatewayEnv.POUCH_PROVIDER_ID,
              countryCode: gatewayEnv.POUCH_COUNTRY_CODE,
              currency: gatewayEnv.POUCH_FIAT_CURRENCY,
              cryptoCurrency: gatewayEnv.POUCH_CRYPTO_CURRENCY,
              cryptoNetwork: gatewayEnv.POUCH_CRYPTO_NETWORK,
              chain: gatewayEnv.POUCH_CHAIN,
              masterWalletAddress: gatewayEnv.POUCH_MASTER_WALLET_ADDRESS,
              testEmail: gatewayEnv.POUCH_TEST_EMAIL,
              userKycDefaults: pouchUserKycDefaults,
            },
          },
          url,
        );
        return;
      }

      if (req.method === "POST") {
        await handleCreateWalletWithdrawalRoute(req, res, {
          privyAppId: gatewayEnv.PRIVY_APP_ID,
          privyVerificationKey: gatewayEnv.PRIVY_VERIFICATION_KEY,
          ridePricingDisplayProvider,
          pouchClient,
          publisher,
          defaults: {
            providerId: gatewayEnv.POUCH_PROVIDER_ID,
            countryCode: gatewayEnv.POUCH_COUNTRY_CODE,
            currency: gatewayEnv.POUCH_FIAT_CURRENCY,
            cryptoCurrency: gatewayEnv.POUCH_CRYPTO_CURRENCY,
            cryptoNetwork: gatewayEnv.POUCH_CRYPTO_NETWORK,
            chain: gatewayEnv.POUCH_CHAIN,
            masterWalletAddress: gatewayEnv.POUCH_MASTER_WALLET_ADDRESS,
            stellarNetwork: gatewayEnv.STELLAR_NETWORK,
            testEmail: gatewayEnv.POUCH_TEST_EMAIL,
            userKycDefaults: pouchUserKycDefaults,
          },
        });
        return;
      }

      sendMethodNotAllowed(res);
      return;
    }

    if (url.pathname.startsWith("/wallet/withdrawals/")) {
      const withdrawalMatch = url.pathname.match(/^\/wallet\/withdrawals\/([^/]+)$/);

      if (!withdrawalMatch) {
        sendJson(res, 404, { error: "Not found" });
        return;
      }

      if (req.method !== "GET") {
        sendMethodNotAllowed(res);
        return;
      }

      await handleGetWalletWithdrawalRoute(req, res, {
        privyAppId: gatewayEnv.PRIVY_APP_ID,
        privyVerificationKey: gatewayEnv.PRIVY_VERIFICATION_KEY,
        ridePricingDisplayProvider,
        pouchClient,
        publisher,
        defaults: {
          providerId: gatewayEnv.POUCH_PROVIDER_ID,
          countryCode: gatewayEnv.POUCH_COUNTRY_CODE,
          currency: gatewayEnv.POUCH_FIAT_CURRENCY,
          cryptoCurrency: gatewayEnv.POUCH_CRYPTO_CURRENCY,
          cryptoNetwork: gatewayEnv.POUCH_CRYPTO_NETWORK,
          chain: gatewayEnv.POUCH_CHAIN,
          masterWalletAddress: gatewayEnv.POUCH_MASTER_WALLET_ADDRESS,
          stellarNetwork: gatewayEnv.STELLAR_NETWORK,
          testEmail: gatewayEnv.POUCH_TEST_EMAIL,
          userKycDefaults: pouchUserKycDefaults,
        },
      }, decodeURIComponent(withdrawalMatch[1]));
      return;
    }

    sendJson(res, 404, {
      error: "Not found",
    });
  });

  createGatewayWebSocketServer({
    server,
    privyAppId: gatewayEnv.PRIVY_APP_ID,
    privyVerificationKey: gatewayEnv.PRIVY_VERIFICATION_KEY,
    allowedOrigins,
    idleTimeoutMs: Number(gatewayEnv.WS_IDLE_TIMEOUT_MS),
    registry,
    publisher,
    routePlanner,
  });

  const outboxPublisher = startOutboxPublisher({
    producer: asRawProducer(producer),
    intervalMs: 500,
    batchSize: 100,
  });

  await startGatewayKafkaConsumer({
    consumer,
    registry,
    ridePricingDisplayProvider,
  });

  const port = Number(gatewayEnv.PORT);

  await new Promise<void>((resolve) => {
    server.listen(port, () => {
      console.log(`[api-gateway] listening on :${port}`);
      resolve();
    });
  });

  onShutdown(async () => {
    await closeServer(server);
  });

  onShutdown(async () => {
    await dispatcherQueue.close();
  });

  onShutdown(async () => {
    await dispatcherRedis.quit();
  });

  onShutdown(async () => {
    outboxPublisher.shutdown();
  });

  onShutdown(async () => {
    await producer.disconnect();
  });

  onShutdown(async () => {
    await consumer.disconnect();
  });

  onShutdown(async () => {
    await redisSubscriberClient.disconnect();
  });

  onShutdown(async () => {
    await redisCommandClient.disconnect();
  });
}

bootstrap().catch((error) => {
  console.error("[api-gateway] Failed to start:", error);
  process.exit(1);
});
