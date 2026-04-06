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
import { handleKorapayWebhookRoute } from './http/korapay.route';
import { handleYellowCardWebhookRoute } from './http/yellowcard.route';
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
  const registry = new SocketRegistry({
    instanceId: `${sharedEnv.KAFKA_CLIENT_ID}-${process.pid}-${Math.random().toString(16).slice(2, 8)}`,
    commandRedis: redisCommandClient,
    subscriberRedis: redisSubscriberClient,
  });
  await registry.start();
  const allowedOrigins = parseAllowedOrigins(gatewayEnv.CORS_ORIGINS);

  const server = createServer(async (req, res) => {
    applyCorsHeaders(req, res, allowedOrigins);

    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      res.end();
      return;
    }

    if (req.method === 'GET' && req.url === '/health') {
      sendJson(res, 200, {
        status: 'ok',
        service: 'api-gateway',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    if (req.url === '/auth/privy') {
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

    if (req.url === '/webhooks/korapay') {
      if (req.method !== 'POST') {
        sendMethodNotAllowed(res);
        return;
      }
      await handleKorapayWebhookRoute(req, res, { publisher });
      return;
    }

    if (req.url === '/webhooks/yellowcard') {
      if (req.method !== 'POST') {
        sendMethodNotAllowed(res);
        return;
      }
      await handleYellowCardWebhookRoute(req, res, { publisher });
      return;
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
