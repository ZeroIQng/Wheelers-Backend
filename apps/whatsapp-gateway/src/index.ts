import { mkdir } from 'fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import { isAbsolute, resolve } from 'path';
import * as qrcode from 'qrcode-terminal';
import { Client, LocalAuth, type Message } from 'whatsapp-web.js';
import { loadWorkspaceEnv, validateWhatsappEnv } from '@wheleers/config';

const SERVICE_ID = 'whatsapp-gateway';

type GatewayState = {
  status: 'initializing' | 'qr_pending' | 'authenticated' | 'ready' | 'auth_failure' | 'disconnected';
  ready: boolean;
  lastError: string | null;
  lastQrAt: string | null;
  lastReadyAt: string | null;
  connectedNumber: string | null;
};

bootstrap().catch((error) => {
  console.error(`[${SERVICE_ID}] fatal`, error);
  process.exit(1);
});

function sendJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  res.statusCode = statusCode;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];

  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  if (chunks.length === 0) {
    return {};
  }

  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getString(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  return typeof value === 'string' ? value : undefined;
}

function extractBearerToken(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const [scheme, token] = value.split(' ');
  if (!scheme || !token || scheme.toLowerCase() !== 'bearer') {
    return undefined;
  }
  return token;
}

function normalizePhoneNumber(value: string): string {
  const trimmed = value.trim();
  if (!/^\+[1-9]\d{7,14}$/.test(trimmed)) {
    throw new Error('phone must be a valid E.164 number, for example +2348012345678');
  }
  return trimmed;
}

function normalizeMessageBody(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error('body is required');
  }
  return trimmed;
}

function phoneToWhatsAppLookup(phone: string): string {
  return phone.replace(/[^\d]/g, '');
}

function resolveSessionPath(rawPath: string): string {
  if (isAbsolute(rawPath)) {
    return rawPath;
  }

  return resolve(__dirname, '../../..', rawPath);
}

async function bootstrap(): Promise<void> {
  loadWorkspaceEnv();
  process.env['NODE_ENV'] ??= 'development';

  const env = validateWhatsappEnv();
  const sessionPath = resolveSessionPath(env.WHATSAPP_SESSION_PATH);
  await mkdir(sessionPath, { recursive: true });

  const state: GatewayState = {
    status: 'initializing',
    ready: false,
    lastError: null,
    lastQrAt: null,
    lastReadyAt: null,
    connectedNumber: null,
  };

  const client = new Client({
    authStrategy: new LocalAuth({
      clientId: env.WHATSAPP_CLIENT_ID,
      dataPath: sessionPath,
    }),
    puppeteer: {
      headless: env.WHATSAPP_HEADLESS !== 'false',
      executablePath: env.WHATSAPP_CHROME_EXECUTABLE_PATH || undefined,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    },
  });

  client.on('qr', (qr) => {
    state.status = 'qr_pending';
    state.ready = false;
    state.lastError = null;
    state.lastQrAt = new Date().toISOString();
    console.log(`[${SERVICE_ID}] scan the QR code below to link the WhatsApp account`);
    qrcode.generate(qr, { small: true });
  });

  client.on('authenticated', () => {
    state.status = 'authenticated';
    state.lastError = null;
    console.log(`[${SERVICE_ID}] session authenticated`);
  });

  client.on('ready', () => {
    state.status = 'ready';
    state.ready = true;
    state.lastError = null;
    state.lastReadyAt = new Date().toISOString();
    state.connectedNumber = client.info.wid._serialized;
    console.log(`[${SERVICE_ID}] ready as ${state.connectedNumber}`);
  });

  client.on('auth_failure', (message) => {
    state.status = 'auth_failure';
    state.ready = false;
    state.lastError = message;
    console.error(`[${SERVICE_ID}] auth failure: ${message}`);
  });

  client.on('disconnected', (reason) => {
    state.status = 'disconnected';
    state.ready = false;
    state.lastError = String(reason);
    console.warn(`[${SERVICE_ID}] disconnected: ${String(reason)}`);
  });

  void client.initialize();

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');

      if (req.method === 'GET' && url.pathname === '/health') {
        sendJson(res, 200, {
          status: 'ok',
          service: SERVICE_ID,
          gateway: state,
          timestamp: new Date().toISOString(),
        });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/session') {
        sendJson(res, 200, state);
        return;
      }

      if (req.method === 'POST' && url.pathname === '/messages/text') {
        const token = extractBearerToken(
          typeof req.headers.authorization === 'string' ? req.headers.authorization : undefined,
        );

        if (token !== env.WHATSAPP_GATEWAY_TOKEN) {
          sendJson(res, 401, { error: 'Unauthorized' });
          return;
        }

        if (!state.ready) {
          sendJson(res, 503, {
            error: 'WhatsApp client is not ready. Check /health and complete QR pairing first.',
            gateway: state,
          });
          return;
        }

        const rawBody = await readJsonBody(req);
        if (!isRecord(rawBody)) {
          sendJson(res, 400, { error: 'Body must be a JSON object' });
          return;
        }

        const phone = normalizePhoneNumber(getString(rawBody, 'phone') ?? '');
        const body = normalizeMessageBody(getString(rawBody, 'body') ?? '');

        const lookup = phoneToWhatsAppLookup(phone);
        const numberId = await client.getNumberId(lookup);
        const chatId = numberId?._serialized;
        if (!chatId) {
          sendJson(res, 404, { error: 'Phone number is not registered on WhatsApp', phone });
          return;
        }

        const message = (await client.sendMessage(chatId, body)) as Message;

        sendJson(res, 200, {
          sent: true,
          phone,
          chatId,
          messageId: message.id._serialized,
        });
        return;
      }

      sendJson(res, 404, { error: 'Not found' });
    } catch (error) {
      sendJson(res, 400, {
        error: error instanceof Error ? error.message : 'Request failed',
      });
    }
  });

  server.listen(Number(env.WHATSAPP_GATEWAY_PORT), () => {
    console.log(`[${SERVICE_ID}] listening on :${env.WHATSAPP_GATEWAY_PORT}`);
  });

  const shutdown = async () => {
    console.log(`[${SERVICE_ID}] shutting down`);
    server.close();
    await client.destroy().catch((error) => {
      console.warn(`[${SERVICE_ID}] client destroy warning:`, error);
    });
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}
