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
  handleCancelScheduledRideRoute,
  handleCreateScheduledRideRoute,
  handleListScheduledRidesRoute,
  handleRideEstimateRoute,
  handleRiderRideHistoryRoute,
} from "./http/ride.route";
import {
  handlePouchChannelsRoute,
  handlePouchCreateSessionRoute,
  handlePouchGetSessionRoute,
  handlePouchHealthRoute,
  handlePouchIdentifyRoute,
  handlePouchKycRequirementsRoute,
  handlePouchQuoteRoute,
  handlePouchSubmitKycRoute,
  handlePouchVerifyOtpRoute,
} from "./http/pouch.route";
import {
  handleSendPhoneOtpRoute,
  handleVerifyPhoneOtpRoute,
} from "./http/phone.route";
import { PouchClient } from "./http/pouch.client";
import { applyCorsHeaders, sendJson } from "./http/utils";
import { startGatewayKafkaConsumer } from "./kafka/consumer";
import { CoinGeckoRidePricingDisplayProvider } from "./pricing/display";
import { RedisClient } from "./redis/client";
import { GatewayPublisher } from "./websocket/publisher";
import { SocketRegistry } from "./websocket/registry";
import { createGatewayWebSocketServer } from "./websocket/server";
import { startOutboxPublisher, asRawProducer } from "@wheleers/ride-service/outbox/outbox-publisher";

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

  const dispatcherQueue = new Queue("wheleers:scheduled-rides", {
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

  const leadTimeMs = 5 * 60 * 1_000;

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

  const scheduledRideDeps = {
    privyAppId: gatewayEnv.PRIVY_APP_ID,
    privyVerificationKey: gatewayEnv.PRIVY_VERIFICATION_KEY,
    routePlanner,
    ridePricingDisplayProvider,
    dispatcherQueue,
    leadTimeMs,
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

    if (url.pathname === "/payments/pouch/channels") {
      if (req.method !== "GET") {
        sendMethodNotAllowed(res);
        return;
      }

      await handlePouchChannelsRoute(req, res, {
        pouchClient,
      });

      return;
    }

    if (url.pathname === "/payments/pouch/sessions") {
      if (req.method !== "POST") {
        sendMethodNotAllowed(res);
        return;
      }

      await handlePouchCreateSessionRoute(req, res, {
        privyAppId: gatewayEnv.PRIVY_APP_ID,
        privyVerificationKey: gatewayEnv.PRIVY_VERIFICATION_KEY,
        pouchClient,
        publisher,
        ridePricingDisplayProvider,
      });

      return;
    }

    if (url.pathname.startsWith("/payments/pouch/sessions/")) {
      const sessionMatch = url.pathname.match(
        /^\/payments\/pouch\/sessions\/([^/]+)(?:\/(quote|identify|verify-otp|kyc-requirements|kyc))?$/,
      );

      if (!sessionMatch) {
        sendJson(res, 404, { error: "Not found" });
        return;
      }

      const sessionId = decodeURIComponent(sessionMatch[1]);
      const action = sessionMatch[2];

      if (!action) {
        if (req.method !== "GET") {
          sendMethodNotAllowed(res);
          return;
        }

        await handlePouchGetSessionRoute(
          req,
          res,
          {
            privyAppId: gatewayEnv.PRIVY_APP_ID,
            privyVerificationKey: gatewayEnv.PRIVY_VERIFICATION_KEY,
            pouchClient,
            publisher,
          },
          sessionId,
        );

        return;
      }

      if (action === "quote") {
        if (req.method !== "GET") {
          sendMethodNotAllowed(res);
          return;
        }

        await handlePouchQuoteRoute(
          req,
          res,
          {
            privyAppId: gatewayEnv.PRIVY_APP_ID,
            privyVerificationKey: gatewayEnv.PRIVY_VERIFICATION_KEY,
            pouchClient,
            publisher,
          },
          sessionId,
        );

        return;
      }

      if (action === "identify") {
        if (req.method !== "POST") {
          sendMethodNotAllowed(res);
          return;
        }

        await handlePouchIdentifyRoute(
          req,
          res,
          {
            privyAppId: gatewayEnv.PRIVY_APP_ID,
            privyVerificationKey: gatewayEnv.PRIVY_VERIFICATION_KEY,
            pouchClient,
            publisher,
          },
          sessionId,
        );

        return;
      }

      if (action === "verify-otp") {
        if (req.method !== "POST") {
          sendMethodNotAllowed(res);
          return;
        }

        await handlePouchVerifyOtpRoute(
          req,
          res,
          {
            privyAppId: gatewayEnv.PRIVY_APP_ID,
            privyVerificationKey: gatewayEnv.PRIVY_VERIFICATION_KEY,
            pouchClient,
            publisher,
          },
          sessionId,
        );

        return;
      }

      if (action === "kyc-requirements") {
        if (req.method !== "GET") {
          sendMethodNotAllowed(res);
          return;
        }

        await handlePouchKycRequirementsRoute(
          req,
          res,
          {
            privyAppId: gatewayEnv.PRIVY_APP_ID,
            privyVerificationKey: gatewayEnv.PRIVY_VERIFICATION_KEY,
            pouchClient,
            publisher,
          },
          sessionId,
        );

        return;
      }

      if (action === "kyc") {
        if (req.method !== "POST") {
          sendMethodNotAllowed(res);
          return;
        }

        await handlePouchSubmitKycRoute(
          req,
          res,
          {
            privyAppId: gatewayEnv.PRIVY_APP_ID,
            privyVerificationKey: gatewayEnv.PRIVY_VERIFICATION_KEY,
            pouchClient,
            publisher,
          },
          sessionId,
        );

        return;
      }
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
