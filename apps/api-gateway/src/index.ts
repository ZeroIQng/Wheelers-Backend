import { createServer, type ServerResponse } from 'http';
import {
  buildTopicList,
  createConsumer,
  createProducer,
  ensureTopics,
  onShutdown,
  registerShutdownHandlers,
  TOPIC_PRESETS,
} from '@wheleers/kafka-client';
import { validateGatewayEnv, validateSharedEnv } from '@wheleers/config';
import { TOPICS } from '@wheleers/kafka-schemas';
import { handlePrivyAuthRoute } from './http/auth.route';
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
} from './http/pouch.route';
import { PouchClient } from './http/pouch.client';
import { applyCorsHeaders, sendJson } from './http/utils';
import { startGatewayKafkaConsumer } from './kafka/consumer';
import { RedisClient } from './redis/client';
import { GatewayPublisher } from './websocket/publisher';
import { SocketRegistry } from './websocket/registry';
import { createGatewayWebSocketServer } from './websocket/server';

function parseAllowedOrigins(raw: string): Set<string> {
  return new Set(
    raw
      .split(',')
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
  sendJson(res, 405, { error: 'Method not allowed' });
}

async function bootstrap(): Promise<void> {
  process.env['NODE_ENV'] ??= 'development';
  process.env['KAFKA_CLIENT_ID'] ??= 'api-gateway';
  process.env['KAFKA_BROKERS'] ??= 'localhost:9092';
  process.env['DATABASE_URL'] ??= 'postgresql://postgres:postgres@localhost:5432/wheelers';
  process.env['REDIS_URL'] ??= 'redis://localhost:6379';

  const sharedEnv = validateSharedEnv();
  const gatewayEnv = validateGatewayEnv();

  registerShutdownHandlers('api-gateway');

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

  const producer = await createProducer({ serviceId: sharedEnv.KAFKA_CLIENT_ID });
  const consumer = await createConsumer({ groupId: sharedEnv.KAFKA_CLIENT_ID });
  const redisCommandClient = new RedisClient(sharedEnv.REDIS_URL);
  const redisSubscriberClient = new RedisClient(sharedEnv.REDIS_URL);

  await redisCommandClient.connect();
  await redisSubscriberClient.connect();

  const publisher = new GatewayPublisher(producer);
  const pouchClient = new PouchClient(
    gatewayEnv.POUCH_BASE_URL,
    gatewayEnv.POUCH_API_KEY,
  );
  const registry = new SocketRegistry({
    instanceId: `${sharedEnv.KAFKA_CLIENT_ID}-${process.pid}-${Math.random().toString(16).slice(2, 8)}`,
    commandRedis: redisCommandClient,
    subscriberRedis: redisSubscriberClient,
  });
  await registry.start();
  const allowedOrigins = parseAllowedOrigins(gatewayEnv.CORS_ORIGINS);

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');

    applyCorsHeaders(req, res, allowedOrigins);

    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      res.end();
      return;
    }

    if (req.method === 'GET' && url.pathname === '/health') {
      sendJson(res, 200, {
        status: 'ok',
        service: 'api-gateway',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    if (url.pathname === '/auth/privy') {
      if (req.method !== 'POST') {
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

    if (url.pathname === '/payments/pouch/health') {
      if (req.method !== 'GET') {
        sendMethodNotAllowed(res);
        return;
      }
      await handlePouchHealthRoute(req, res, {
        pouchClient,
      });
      return;
    }

    if (url.pathname === '/payments/pouch/channels') {
      if (req.method !== 'GET') {
        sendMethodNotAllowed(res);
        return;
      }
      await handlePouchChannelsRoute(req, res, {
        pouchClient,
      });
      return;
    }

    if (url.pathname === '/payments/pouch/sessions') {
      if (req.method !== 'POST') {
        sendMethodNotAllowed(res);
        return;
      }
      await handlePouchCreateSessionRoute(req, res, {
        privyAppId: gatewayEnv.PRIVY_APP_ID,
        privyVerificationKey: gatewayEnv.PRIVY_VERIFICATION_KEY,
        pouchClient,
        publisher,
      });
      return;
    }

    if (url.pathname.startsWith('/payments/pouch/sessions/')) {
      const sessionMatch = url.pathname.match(
        /^\/payments\/pouch\/sessions\/([^/]+)(?:\/(quote|identify|verify-otp|kyc-requirements|kyc))?$/,
      );

      if (!sessionMatch) {
        sendJson(res, 404, { error: 'Not found' });
        return;
      }

      const sessionId = decodeURIComponent(sessionMatch[1]);
      const action = sessionMatch[2];

      if (!action) {
        if (req.method !== 'GET') {
          sendMethodNotAllowed(res);
          return;
        }

        await handlePouchGetSessionRoute(req, res, {
          privyAppId: gatewayEnv.PRIVY_APP_ID,
          privyVerificationKey: gatewayEnv.PRIVY_VERIFICATION_KEY,
          pouchClient,
          publisher,
        }, sessionId);
        return;
      }

      if (action === 'quote') {
        if (req.method !== 'GET') {
          sendMethodNotAllowed(res);
          return;
        }

        await handlePouchQuoteRoute(req, res, {
          privyAppId: gatewayEnv.PRIVY_APP_ID,
          privyVerificationKey: gatewayEnv.PRIVY_VERIFICATION_KEY,
          pouchClient,
          publisher,
        }, sessionId);
        return;
      }

      if (action === 'identify') {
        if (req.method !== 'POST') {
          sendMethodNotAllowed(res);
          return;
        }

        await handlePouchIdentifyRoute(req, res, {
          privyAppId: gatewayEnv.PRIVY_APP_ID,
          privyVerificationKey: gatewayEnv.PRIVY_VERIFICATION_KEY,
          pouchClient,
          publisher,
        }, sessionId);
        return;
      }

      if (action === 'verify-otp') {
        if (req.method !== 'POST') {
          sendMethodNotAllowed(res);
          return;
        }

        await handlePouchVerifyOtpRoute(req, res, {
          privyAppId: gatewayEnv.PRIVY_APP_ID,
          privyVerificationKey: gatewayEnv.PRIVY_VERIFICATION_KEY,
          pouchClient,
          publisher,
        }, sessionId);
        return;
      }

      if (action === 'kyc-requirements') {
        if (req.method !== 'GET') {
          sendMethodNotAllowed(res);
          return;
        }

        await handlePouchKycRequirementsRoute(req, res, {
          privyAppId: gatewayEnv.PRIVY_APP_ID,
          privyVerificationKey: gatewayEnv.PRIVY_VERIFICATION_KEY,
          pouchClient,
          publisher,
        }, sessionId);
        return;
      }

      if (action === 'kyc') {
        if (req.method !== 'POST') {
          sendMethodNotAllowed(res);
          return;
        }

        await handlePouchSubmitKycRoute(req, res, {
          privyAppId: gatewayEnv.PRIVY_APP_ID,
          privyVerificationKey: gatewayEnv.PRIVY_VERIFICATION_KEY,
          pouchClient,
          publisher,
        }, sessionId);
        return;
      }
    }

    sendJson(res, 404, { error: 'Not found' });
  });

  createGatewayWebSocketServer({
    server,
    privyAppId: gatewayEnv.PRIVY_APP_ID,
    privyVerificationKey: gatewayEnv.PRIVY_VERIFICATION_KEY,
    allowedOrigins,
    idleTimeoutMs: Number(gatewayEnv.WS_IDLE_TIMEOUT_MS),
    registry,
    publisher,
  });

  await startGatewayKafkaConsumer({
    consumer,
    registry,
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
  console.error('[api-gateway] Failed to start:', error);
  process.exit(1);
});
