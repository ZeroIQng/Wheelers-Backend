import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { readFile } from "node:fs/promises";
import { join, extname, resolve } from "node:path";
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

import {
  handleUsernamePasswordSigninRoute,
  handleUsernamePasswordSignupRoute,
} from "./http/auth.route";
import {
  handleAppleAuthRoute,
  handleGoogleAuthRoute,
} from "./http/social-auth.route";
import {
  handleLogoutRoute,
  handleDeleteAccountRoute,
} from "./http/account.route";
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
  handleGetDriverStatsRoute,
  handleGetDriverEarningsRoute,
  handleGetDriverRideHistoryRoute,
} from "./http/driver.route";
import {
  handleDriverKycSubmitRoute,
  handleDriverKycStatusRoute,
} from "./http/driver-kyc.route";
import {
  handleAdminListDriversRoute,
  handleAdminGetDriverRoute,
  handleAdminApproveDriverRoute,
  handleAdminRejectDriverRoute,
  handleAdminFieldReviewRoute,
} from "./http/admin.route";
import {
  handleAdminLoginRoute,
  handleCreateAdminRoute,
} from "./http/admin-auth.route";
import {
  handleAdminPlatformStatsRoute,
  handleAdminDriverAnalyticsRoute,
  handleAdminRiderAnalyticsRoute,
  handleAdminRecentRidesRoute,
} from "./http/admin-analytics.route";
import {
  handleCancelGroupRideMatchRequestRoute,
  handleCompleteGroupRideFaceUploadRoute,
  handleCreateGroupRideFaceUploadUrlRoute,
  handleCreateGroupRideMatchRequestRoute,
  handleGetGroupRideMatchRequestRoute,
  handleListGroupRideMatchRequestsRoute,
} from "./http/group-ride.route";
import {
  handlePouchWebhookRoute,
} from "./http/pouch.route";
import {
  handleCreateWalletWithdrawalRoute,
  handleGetWalletWithdrawalRoute,
  handleListWithdrawalBankNetworksRoute,
  handleListWalletWithdrawalsRoute,
  handleProvisionVirtualAccountRoute,
  handleVerifyWithdrawalBankAccountRoute,
  handleWalletOverviewRoute,
  handleWalletTransactionsRoute,
  handleWalletDepositInfoRoute,
} from "./http/wallet.route";
import { PouchLiquifiaClient } from "@wheleers/pouch-client";
import {
  handleSendPhoneOtpRoute,
  handleVerifyPhoneOtpRoute,
} from "./http/phone.route";
import { handleMetaWhatsappWebhookRoute, handleMetaWhatsappVerify } from "./http/whatsapp.route";
import {
  handleApplyReferralCodeRoute,
  handleGetReferralSummaryRoute,
  handleListReferralCashbackRoute,
  handleListReferralReferralsRoute,
  handlePreviewReferralRideCashbackRoute,
} from "./http/referral.route";
import {
  handleGetKycStatusRoute,
  handleVerifyKycRoute,
} from "./http/kyc.route";
import { handleGetRideChatMessagesRoute } from "./http/chat.route";
import { applyCorsHeaders, sendJson } from "./http/utils";
import { startGatewayKafkaConsumer } from "./kafka/consumer";
// COMMENTED OUT: WhatsApp Flows — using pure chat-based ride booking instead
// import { handleWhatsappFlowEndpoint } from "./whatsapp-flows/flow-endpoint";
// import { handleRideSearchFlowEndpoint } from "./whatsapp-flows/ride-search-flow-endpoint";
import { RedisClient } from "./redis/client";
import { asRawProducer, startOutboxPublisher } from "./outbox/outbox-publisher";
import { GatewayPublisher } from "./websocket/publisher";
import { SocketRegistry } from "./websocket/registry";
import { createGatewayWebSocketServer } from "./websocket/server";
import { GroupRideFaceStorage } from "./storage/group-ride-face-storage";
import { RiderKycFaceStorage } from "./storage/rider-kyc-face-storage";
import { DriverKycStorage } from "./storage/driver-kyc-storage";
import { startReferralJobs } from "./referrals/jobs";

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

const WIDGET_DIR = join(__dirname, "..", "widget");
const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
};

async function serveWidgetFile(pathname: string, res: ServerResponse): Promise<void> {
  // Only allow known extensions to prevent path traversal / serving unexpected files
  const ext = extname(pathname);
  const contentType = MIME_TYPES[ext];
  if (!contentType) {
    sendJson(res, 404, { error: "Not found" });
    return;
  }

  // Strip leading /widget/ and resolve against widget dir
  const relative = pathname.replace(/^\/widget\//, "");
  if (relative.includes("..") || relative.includes("\0")) {
    sendJson(res, 400, { error: "Invalid path" });
    return;
  }

  const filePath = resolve(WIDGET_DIR, relative);
  // Canonical path must stay inside WIDGET_DIR
  if (!filePath.startsWith(resolve(WIDGET_DIR) + "/")) {
    sendJson(res, 400, { error: "Invalid path" });
    return;
  }

  try {
    const data = await readFile(filePath);
    res.writeHead(200, { "Content-Type": contentType, "Cache-Control": "no-cache" });
    res.end(data);
  } catch {
    sendJson(res, 404, { error: "Not found" });
  }
}

function getHeaderValue(req: IncomingMessage, name: string): string | null {
  const value = req.headers[name.toLowerCase()];
  return typeof value === "string" ? value : null;
}

function getClientIp(req: IncomingMessage): string | null {
  const forwardedFor = getHeaderValue(req, "x-forwarded-for");
  if (forwardedFor) {
    return forwardedFor.split(",")[0]?.trim() || null;
  }

  return req.socket.remoteAddress ?? null;
}

function getSafePathForLog(url: URL): string {
  if (url.searchParams.size === 0) {
    return url.pathname;
  }

  const queryKeys = Array.from(url.searchParams.keys())
    .filter((key) => !/token|secret|password|authorization|otp|code/i.test(key))
    .sort();

  return queryKeys.length > 0
    ? `${url.pathname}?${queryKeys.map((key) => `${key}=<redacted>`).join("&")}`
    : url.pathname;
}

function logHttpRequestStart(req: IncomingMessage, url: URL): void {
  console.info("[http] request", {
    method: req.method ?? null,
    path: getSafePathForLog(url),
    origin: getHeaderValue(req, "origin"),
    ip: getClientIp(req),
    userAgent: getHeaderValue(req, "user-agent"),
  });
}

function attachHttpResponseLogger(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  startedAt: number,
): void {
  res.on("finish", () => {
    console.info("[http] response", {
      method: req.method ?? null,
      path: getSafePathForLog(url),
      statusCode: res.statusCode,
      durationMs: Date.now() - startedAt,
      origin: getHeaderValue(req, "origin"),
      ip: getClientIp(req),
    });
  });
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
      [TOPICS.CRYPTO_WALLET_EVENTS, TOPIC_PRESETS.LOW_VOLUME],
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

  const pouchLiquifiaClient = new PouchLiquifiaClient({
    baseUrl: gatewayEnv.POUCH_LIQUIFIA_BASE_URL,
    apiKey: gatewayEnv.POUCH_LIQUIFIA_API_KEY,
  });

  const routePlanner = new GoogleMapsRoutePlanner(
    gatewayEnv.GOOGLE_MAPS_BASE_URL,
    gatewayEnv.GOOGLE_MAPS_API_KEY,
  );

  const r2Configured = !!(gatewayEnv.R2_ACCOUNT_ID && gatewayEnv.R2_ACCESS_KEY_ID && gatewayEnv.R2_SECRET_ACCESS_KEY && gatewayEnv.R2_BUCKET);

  const groupRideFaceStorage = r2Configured
    ? new GroupRideFaceStorage({
        accountId: gatewayEnv.R2_ACCOUNT_ID!,
        accessKeyId: gatewayEnv.R2_ACCESS_KEY_ID!,
        secretAccessKey: gatewayEnv.R2_SECRET_ACCESS_KEY!,
        bucket: gatewayEnv.R2_BUCKET!,
        prefix: gatewayEnv.GROUP_RIDE_FACE_S3_PREFIX,
        uploadUrlTtlSeconds: gatewayEnv.GROUP_RIDE_FACE_UPLOAD_URL_TTL_S,
      })
    : undefined;

  const riderKycFaceStorage = r2Configured
    ? new RiderKycFaceStorage({
        accountId: gatewayEnv.R2_ACCOUNT_ID!,
        accessKeyId: gatewayEnv.R2_ACCESS_KEY_ID!,
        secretAccessKey: gatewayEnv.R2_SECRET_ACCESS_KEY!,
        bucket: gatewayEnv.R2_BUCKET!,
        prefix: gatewayEnv.RIDER_KYC_S3_PREFIX,
      })
    : null;

  const driverKycStorage = r2Configured
    ? new DriverKycStorage({
        accountId: gatewayEnv.R2_ACCOUNT_ID!,
        accessKeyId: gatewayEnv.R2_ACCESS_KEY_ID!,
        secretAccessKey: gatewayEnv.R2_SECRET_ACCESS_KEY!,
        bucket: gatewayEnv.R2_BUCKET!,
        prefix: 'drivers/kyc',
      })
    : null;

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
    jwtSecret: gatewayEnv.JWT_SECRET,
    routePlanner,
    dispatcherQueue,
    leadTimeMs,
    redisClient: redisCommandClient,
  };

  const groupRideDeps = {
    jwtSecret: gatewayEnv.JWT_SECRET,
    routePlanner,
    publisher,
    redisClient: redisCommandClient,
    faceStorage: groupRideFaceStorage,
  };

  const walletDeps = {
    jwtSecret: gatewayEnv.JWT_SECRET,
    publisher,
    pouchLiquifiaClient,
    redisClient: redisCommandClient,
  };

  const kycDeps = {
    jwtSecret: gatewayEnv.JWT_SECRET,
    publisher,
    faceStorage: riderKycFaceStorage,
  };

  const server = createServer(async (req, res) => {
    const startedAt = Date.now();
    const url = new URL(req.url ?? "/", "http://localhost");
    attachHttpResponseLogger(req, res, url, startedAt);
    logHttpRequestStart(req, url);

    try {
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

    if (url.pathname === "/auth/signup") {
      if (req.method !== "POST") {
        sendMethodNotAllowed(res);
        return;
      }

      await handleUsernamePasswordSignupRoute(req, res, {
        jwtSecret: gatewayEnv.JWT_SECRET,
        publisher,
        pouchLiquifiaClient,
      });

      return;
    }

    if (url.pathname === "/auth/signin") {
      if (req.method !== "POST") {
        sendMethodNotAllowed(res);
        return;
      }

      await handleUsernamePasswordSigninRoute(req, res, {
        jwtSecret: gatewayEnv.JWT_SECRET,
      });

      return;
    }

    if (url.pathname === "/auth/apple") {
      if (req.method !== "POST") {
        sendMethodNotAllowed(res);
        return;
      }

      await handleAppleAuthRoute(req, res, {
        jwtSecret: gatewayEnv.JWT_SECRET,
        appleBundleId: gatewayEnv.APPLE_BUNDLE_ID,
        googleClientId: gatewayEnv.GOOGLE_CLIENT_ID,
        pouchLiquifiaClient,
      });

      return;
    }

    if (url.pathname === "/auth/google") {
      if (req.method !== "POST") {
        sendMethodNotAllowed(res);
        return;
      }

      await handleGoogleAuthRoute(req, res, {
        jwtSecret: gatewayEnv.JWT_SECRET,
        appleBundleId: gatewayEnv.APPLE_BUNDLE_ID,
        googleClientId: gatewayEnv.GOOGLE_CLIENT_ID,
        pouchLiquifiaClient,
      });

      return;
    }

    if (url.pathname === "/auth/me") {
      if (req.method !== "GET") {
        sendMethodNotAllowed(res);
        return;
      }

      await handleGetCurrentProfileRoute(req, res, {
        jwtSecret: gatewayEnv.JWT_SECRET,
      });
      return;
    }

    if (url.pathname === "/auth/profile") {
      if (req.method !== "PUT") {
        sendMethodNotAllowed(res);
        return;
      }

      await handleUpdateCurrentProfileRoute(req, res, {
        jwtSecret: gatewayEnv.JWT_SECRET,
      });
      return;
    }

    if (url.pathname === "/auth/logout") {
      if (req.method !== "POST") {
        sendMethodNotAllowed(res);
        return;
      }

      await handleLogoutRoute(req, res, {
        jwtSecret: gatewayEnv.JWT_SECRET,
        redisClient: redisCommandClient,
      });
      return;
    }

    if (url.pathname === "/auth/delete-account") {
      if (req.method !== "POST") {
        sendMethodNotAllowed(res);
        return;
      }

      await handleDeleteAccountRoute(req, res, {
        jwtSecret: gatewayEnv.JWT_SECRET,
        redisClient: redisCommandClient,
      });
      return;
    }

    if (url.pathname === "/referrals/me") {
      if (req.method !== "GET") {
        sendMethodNotAllowed(res);
        return;
      }

      await handleGetReferralSummaryRoute(req, res, {
        jwtSecret: gatewayEnv.JWT_SECRET,
      });
      return;
    }

    if (url.pathname === "/referrals/apply") {
      if (req.method !== "POST") {
        sendMethodNotAllowed(res);
        return;
      }

      await handleApplyReferralCodeRoute(req, res, {
        jwtSecret: gatewayEnv.JWT_SECRET,
      });
      return;
    }

    if (url.pathname === "/referrals/me/referrals") {
      if (req.method !== "GET") {
        sendMethodNotAllowed(res);
        return;
      }

      await handleListReferralReferralsRoute(req, res, {
        jwtSecret: gatewayEnv.JWT_SECRET,
      });
      return;
    }

    if (url.pathname === "/referrals/me/cashback") {
      if (req.method !== "GET") {
        sendMethodNotAllowed(res);
        return;
      }

      await handleListReferralCashbackRoute(req, res, {
        jwtSecret: gatewayEnv.JWT_SECRET,
      });
      return;
    }

    if (url.pathname === "/referrals/me/cashback/ride-preview") {
      if (req.method !== "POST") {
        sendMethodNotAllowed(res);
        return;
      }

      await handlePreviewReferralRideCashbackRoute(req, res, {
        jwtSecret: gatewayEnv.JWT_SECRET,
      });
      return;
    }

    if (url.pathname === "/notifications") {
      if (req.method === "GET") {
        await handleListNotificationsRoute(req, res, {
          jwtSecret: gatewayEnv.JWT_SECRET,
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
        jwtSecret: gatewayEnv.JWT_SECRET,
      });
      return;
    }

    if (url.pathname === "/notifications/device") {
      if (req.method !== "POST") {
        sendMethodNotAllowed(res);
        return;
      }

      await handleRegisterPushTokenRoute(req, res, {
        jwtSecret: gatewayEnv.JWT_SECRET,
      });
      return;
    }

    if (url.pathname === "/auth/phone/send-otp") {
      if (req.method !== "POST") {
        sendMethodNotAllowed(res);
        return;
      }

      await handleSendPhoneOtpRoute(req, res, {
        jwtSecret: gatewayEnv.JWT_SECRET,
        redisClient: redisCommandClient,
        whatsappGatewayUrl: gatewayEnv.WHATSAPP_GATEWAY_URL,
        whatsappGatewayToken: gatewayEnv.WHATSAPP_GATEWAY_TOKEN,
        twilioAccountSid: gatewayEnv.TWILIO_ACCOUNT_SID,
        twilioAuthToken: gatewayEnv.TWILIO_AUTH_TOKEN,
        twilioFromNumber: gatewayEnv.TWILIO_FROM_NUMBER,
        phoneOtpTtlSeconds: gatewayEnv.WHATSAPP_OTP_TTL_SECONDS,
      });

      return;
    }

    if (url.pathname === "/webhooks/whatsapp") {
      const metaWhatsappDeps = {
        jwtSecret: gatewayEnv.JWT_SECRET,
        publisher,
        pouchLiquifiaClient,
        redisClient: redisCommandClient,
        routePlanner,
        googleMapsApiKey: gatewayEnv.GOOGLE_MAPS_API_KEY,
        metaAccessToken: gatewayEnv.META_ACCESS_TOKEN,
        metaPhoneNumberId: gatewayEnv.META_PHONE_NUMBER_ID,
        metaAppSecret: gatewayEnv.META_APP_SECRET,
        metaWebhookVerifyToken: gatewayEnv.META_WEBHOOK_VERIFY_TOKEN,
        groqApiKey: gatewayEnv.GROQ_API_KEY,
        groqModel: gatewayEnv.GROQ_MODEL,
        groqTimeoutMs: gatewayEnv.GROQ_TIMEOUT_MS,
        appBaseUrl: gatewayEnv.APP_BASE_URL,
        driverKycStorage: driverKycStorage ?? undefined,
      };

      if (req.method === "GET") {
        handleMetaWhatsappVerify(req, res, metaWhatsappDeps);
        return;
      }

      if (req.method === "POST") {
        await handleMetaWhatsappWebhookRoute(req, res, metaWhatsappDeps);
        return;
      }

      sendMethodNotAllowed(res);
      return;
    }

    // COMMENTED OUT: WhatsApp Flows endpoints — using pure chat-based ride booking
    // if (url.pathname === "/webhooks/whatsapp-ride-search-flow") { ... }
    // if (url.pathname === "/webhooks/whatsapp-flow") { ... }




    if (url.pathname === "/auth/phone/verify-otp") {
      if (req.method !== "POST") {
        sendMethodNotAllowed(res);
        return;
      }

      await handleVerifyPhoneOtpRoute(req, res, {
        jwtSecret: gatewayEnv.JWT_SECRET,
        redisClient: redisCommandClient,
        whatsappGatewayUrl: gatewayEnv.WHATSAPP_GATEWAY_URL,
        whatsappGatewayToken: gatewayEnv.WHATSAPP_GATEWAY_TOKEN,
        twilioAccountSid: gatewayEnv.TWILIO_ACCOUNT_SID,
        twilioAuthToken: gatewayEnv.TWILIO_AUTH_TOKEN,
        twilioFromNumber: gatewayEnv.TWILIO_FROM_NUMBER,
        phoneOtpTtlSeconds: gatewayEnv.WHATSAPP_OTP_TTL_SECONDS,
      });

      return;
    }

    if (url.pathname === "/drivers/me/stats") {
      if (req.method !== "GET") {
        sendMethodNotAllowed(res);
        return;
      }

      await handleGetDriverStatsRoute(req, res, {
        jwtSecret: gatewayEnv.JWT_SECRET,
      });
      return;
    }

    if (url.pathname === "/drivers/me/earnings") {
      if (req.method !== "GET") {
        sendMethodNotAllowed(res);
        return;
      }

      await handleGetDriverEarningsRoute(req, res, {
        jwtSecret: gatewayEnv.JWT_SECRET,
      }, url);
      return;
    }

    if (url.pathname === "/drivers/me/rides/history") {
      if (req.method !== "GET") {
        sendMethodNotAllowed(res);
        return;
      }

      await handleGetDriverRideHistoryRoute(req, res, {
        jwtSecret: gatewayEnv.JWT_SECRET,
      }, url);
      return;
    }

    // ── Driver KYC routes ──────────────────────────────────────────────────

    if (url.pathname === "/drivers/kyc/submit") {
      if (req.method !== "POST") {
        sendMethodNotAllowed(res);
        return;
      }

      if (!driverKycStorage) {
        sendJson(res, 503, { error: 'KYC storage not configured' });
        return;
      }

      await handleDriverKycSubmitRoute(req, res, {
        jwtSecret: gatewayEnv.JWT_SECRET,
        kycStorage: driverKycStorage,
      });
      return;
    }

    if (url.pathname === "/drivers/kyc/status") {
      if (req.method !== "GET") {
        sendMethodNotAllowed(res);
        return;
      }

      await handleDriverKycStatusRoute(req, res, {
        jwtSecret: gatewayEnv.JWT_SECRET,
      });
      return;
    }

    // ── Admin auth routes ──────────────────────────────────────────────────

    if (url.pathname === "/admin/login") {
      if (req.method !== "POST") {
        sendMethodNotAllowed(res);
        return;
      }

      await handleAdminLoginRoute(req, res, {
        jwtSecret: gatewayEnv.JWT_SECRET,
        adminApiKey: process.env.ADMIN_API_KEY ?? '',
      });
      return;
    }

    if (url.pathname === "/admin/create-admin") {
      if (req.method !== "POST") {
        sendMethodNotAllowed(res);
        return;
      }

      await handleCreateAdminRoute(req, res, {
        jwtSecret: gatewayEnv.JWT_SECRET,
        adminApiKey: process.env.ADMIN_API_KEY ?? '',
      });
      return;
    }

    // ── Admin routes ──────────────────────────────────────────────────────

    if (url.pathname === "/admin/drivers") {
      if (req.method !== "GET") {
        sendMethodNotAllowed(res);
        return;
      }

      if (!driverKycStorage) {
        sendJson(res, 503, { error: 'Storage not configured' });
        return;
      }

      await handleAdminListDriversRoute(req, res, {
        adminApiKey: process.env.ADMIN_API_KEY ?? '',
        jwtSecret: gatewayEnv.JWT_SECRET,
        kycStorage: driverKycStorage,
      });
      return;
    }

    if (url.pathname.startsWith("/admin/drivers/")) {
      const approveMatch = url.pathname.match(/^\/admin\/drivers\/([^/]+)\/approve$/);
      if (approveMatch) {
        if (req.method !== "POST") {
          sendMethodNotAllowed(res);
          return;
        }

        if (!driverKycStorage) {
          sendJson(res, 503, { error: 'Storage not configured' });
          return;
        }

        await handleAdminApproveDriverRoute(req, res, {
          adminApiKey: process.env.ADMIN_API_KEY ?? '',
          jwtSecret: gatewayEnv.JWT_SECRET,
          kycStorage: driverKycStorage,
        }, approveMatch[1]!);
        return;
      }

      const fieldReviewMatch = url.pathname.match(/^\/admin\/drivers\/([^/]+)\/field-review$/);
      if (fieldReviewMatch) {
        if (req.method !== "POST") {
          sendMethodNotAllowed(res);
          return;
        }

        if (!driverKycStorage) {
          sendJson(res, 503, { error: 'Storage not configured' });
          return;
        }

        await handleAdminFieldReviewRoute(req, res, {
          adminApiKey: process.env.ADMIN_API_KEY ?? '',
          jwtSecret: gatewayEnv.JWT_SECRET,
          kycStorage: driverKycStorage,
        }, fieldReviewMatch[1]!);
        return;
      }

      const rejectMatch = url.pathname.match(/^\/admin\/drivers\/([^/]+)\/reject$/);
      if (rejectMatch) {
        if (req.method !== "POST") {
          sendMethodNotAllowed(res);
          return;
        }

        if (!driverKycStorage) {
          sendJson(res, 503, { error: 'Storage not configured' });
          return;
        }

        await handleAdminRejectDriverRoute(req, res, {
          adminApiKey: process.env.ADMIN_API_KEY ?? '',
          jwtSecret: gatewayEnv.JWT_SECRET,
          kycStorage: driverKycStorage,
        }, rejectMatch[1]!);
        return;
      }

      const driverDetailMatch = url.pathname.match(/^\/admin\/drivers\/([^/]+)$/);
      if (driverDetailMatch) {
        if (req.method !== "GET") {
          sendMethodNotAllowed(res);
          return;
        }

        if (!driverKycStorage) {
          sendJson(res, 503, { error: 'Storage not configured' });
          return;
        }

        await handleAdminGetDriverRoute(req, res, {
          adminApiKey: process.env.ADMIN_API_KEY ?? '',
          jwtSecret: gatewayEnv.JWT_SECRET,
          kycStorage: driverKycStorage,
        }, driverDetailMatch[1]!);
        return;
      }
    }

    // ── Admin analytics routes ──────────────────────────────────────────────

    if (url.pathname === "/admin/analytics/platform") {
      if (req.method !== "GET") {
        sendMethodNotAllowed(res);
        return;
      }

      await handleAdminPlatformStatsRoute(req, res, {
        adminApiKey: process.env.ADMIN_API_KEY ?? '',
        jwtSecret: gatewayEnv.JWT_SECRET,
      });
      return;
    }

    if (url.pathname === "/admin/analytics/drivers") {
      if (req.method !== "GET") {
        sendMethodNotAllowed(res);
        return;
      }

      await handleAdminDriverAnalyticsRoute(req, res, {
        adminApiKey: process.env.ADMIN_API_KEY ?? '',
        jwtSecret: gatewayEnv.JWT_SECRET,
      });
      return;
    }

    if (url.pathname === "/admin/analytics/riders") {
      if (req.method !== "GET") {
        sendMethodNotAllowed(res);
        return;
      }

      await handleAdminRiderAnalyticsRoute(req, res, {
        adminApiKey: process.env.ADMIN_API_KEY ?? '',
        jwtSecret: gatewayEnv.JWT_SECRET,
      });
      return;
    }

    if (url.pathname === "/admin/analytics/recent-rides") {
      if (req.method !== "GET") {
        sendMethodNotAllowed(res);
        return;
      }

      await handleAdminRecentRidesRoute(req, res, {
        adminApiKey: process.env.ADMIN_API_KEY ?? '',
        jwtSecret: gatewayEnv.JWT_SECRET,
      });
      return;
    }

    // GET /rides/:rideId/messages — chat history
    if (url.pathname.startsWith("/rides/") && url.pathname.endsWith("/messages")) {
      const chatMatch = url.pathname.match(/^\/rides\/([^/]+)\/messages$/);
      if (chatMatch) {
        if (req.method !== "GET") {
          sendMethodNotAllowed(res);
          return;
        }

        const handler = handleGetRideChatMessagesRoute({
          jwtSecret: gatewayEnv.JWT_SECRET,
        });
        await handler(req, res, { rideId: chatMatch[1] });
        return;
      }
    }

    if (url.pathname === "/rides/estimate") {
      if (req.method !== "POST") {
        sendMethodNotAllowed(res);
        return;
      }

      await handleRideEstimateRoute(req, res, {
        jwtSecret: gatewayEnv.JWT_SECRET,
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
          jwtSecret: gatewayEnv.JWT_SECRET,
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

    if (url.pathname === "/wallet/overview") {
      if (req.method !== "GET") {
        sendMethodNotAllowed(res);
        return;
      }

      await handleWalletOverviewRoute(req, res, walletDeps);
      return;
    }

    if (url.pathname === "/wallet/deposit-info") {
      if (req.method !== "GET") {
        sendMethodNotAllowed(res);
        return;
      }

      await handleWalletDepositInfoRoute(req, res, walletDeps);
      return;
    }

    if (url.pathname === "/wallet/provision-virtual-account") {
      if (req.method !== "POST") {
        sendMethodNotAllowed(res);
        return;
      }

      await handleProvisionVirtualAccountRoute(req, res, walletDeps);
      return;
    }

    if (url.pathname === "/wallet/transactions") {
      if (req.method !== "GET") {
        sendMethodNotAllowed(res);
        return;
      }

      await handleWalletTransactionsRoute(req, res, walletDeps, url);
      return;
    }

    if (url.pathname === "/wallet/withdrawals/bank-networks") {
      if (req.method !== "GET") {
        sendMethodNotAllowed(res);
        return;
      }

      await handleListWithdrawalBankNetworksRoute(req, res, walletDeps, url);
      return;
    }

    if (url.pathname === "/wallet/withdrawals/verify-bank-account") {
      if (req.method !== "POST") {
        sendMethodNotAllowed(res);
        return;
      }

      await handleVerifyWithdrawalBankAccountRoute(req, res, walletDeps);
      return;
    }

    if (url.pathname === "/wallet/withdrawals") {
      if (req.method === "GET") {
        await handleListWalletWithdrawalsRoute(req, res, walletDeps, url);
        return;
      }

      if (req.method === "POST") {
        await handleCreateWalletWithdrawalRoute(req, res, walletDeps);
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

      await handleGetWalletWithdrawalRoute(
        req, res, walletDeps, decodeURIComponent(withdrawalMatch[1]),
      );
      return;
    }

    // ── KYC routes ──────────────────────────────────────────────────────────
    if (url.pathname === "/kyc/status") {
      if (req.method !== "GET") {
        sendMethodNotAllowed(res);
        return;
      }

      await handleGetKycStatusRoute(req, res, kycDeps);
      return;
    }

    if (url.pathname === "/kyc/verify") {
      if (req.method !== "POST") {
        sendMethodNotAllowed(res);
        return;
      }

      await handleVerifyKycRoute(req, res, kycDeps);
      return;
    }

    // ── Widget static files ──────────────────────────────────────────────────
    if (req.method === "GET" && url.pathname.startsWith("/widget/")) {
      await serveWidgetFile(url.pathname, res);
      return;
    }

    sendJson(res, 404, {
      error: "Not found",
    });
    } catch (error) {
      console.error("[http] unhandled request error", {
        method: req.method ?? null,
        path: getSafePathForLog(url),
        statusCode: res.statusCode,
        durationMs: Date.now() - startedAt,
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });

      if (!res.headersSent) {
        sendJson(res, 500, { error: "Internal server error" });
        return;
      }

      res.destroy(error instanceof Error ? error : undefined);
    }
  });

  createGatewayWebSocketServer({
    server,
    jwtSecret: gatewayEnv.JWT_SECRET,
    allowedOrigins,
    idleTimeoutMs: Number(gatewayEnv.WS_IDLE_TIMEOUT_MS),
    registry,
    publisher,
    routePlanner,
  });

  const outboxPublisher = startOutboxPublisher({
    producer: asRawProducer(producer),
    intervalMs: 2_000,
    batchSize: 100,
  });

  const referralJobs = startReferralJobs();

  await startGatewayKafkaConsumer({
    consumer,
    registry,
    publisher,
    redisClient: redisCommandClient,
    whatsappNotifier:
      gatewayEnv.META_ACCESS_TOKEN && gatewayEnv.META_PHONE_NUMBER_ID
        ? {
            metaAccessToken: gatewayEnv.META_ACCESS_TOKEN,
            metaPhoneNumberId: gatewayEnv.META_PHONE_NUMBER_ID,
          }
        : undefined,
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
    referralJobs.shutdown();
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

process.on("unhandledRejection", (reason) => {
  console.error("[api-gateway] unhandled rejection", {
    message: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack : undefined,
  });
});

process.on("uncaughtException", (error) => {
  console.error("[api-gateway] uncaught exception", {
    message: error.message,
    stack: error.stack,
  });
  process.exit(1);
});

bootstrap().catch((error) => {
  console.error("[api-gateway] Failed to start:", error);
  process.exit(1);
});
