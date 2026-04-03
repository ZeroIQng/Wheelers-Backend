import type { IncomingMessage, Server as HttpServer } from 'http';
import type { Duplex } from 'stream';
import WebSocket, { Server as WebSocketServer } from 'ws';
import { buildGatewayAuthContext } from '../auth/context';
import { extractBearerToken, verifyHs256Jwt } from '../auth/jwt';
import type { InboundWsMessage } from '../types';
import { isRecord } from '../utils/object';
import { handleDriverMessage } from './handlers/driver.handler';
import { handleRideMessage } from './handlers/ride.handler';
import { handleWalletMessage } from './handlers/wallet.handler';
import type { GatewayPublisher } from './publisher';
import { SocketRegistry } from './registry';

interface WebSocketServerDeps {
  server: HttpServer;
  jwtSecret: string;
  allowedOrigins: Set<string>;
  idleTimeoutMs: number;
  registry: SocketRegistry;
  publisher: GatewayPublisher;
}

function getRequestOrigin(request: IncomingMessage): string | null {
  const origin = request.headers.origin;
  return typeof origin === 'string' ? origin : null;
}

function getConnectionToken(request: IncomingMessage, params: URLSearchParams): string | null {
  const headerToken = extractBearerToken(
    typeof request.headers.authorization === 'string' ? request.headers.authorization : undefined,
  );

  if (headerToken) return headerToken;

  const queryToken = params.get('token');
  if (queryToken && queryToken.trim().length > 0) {
    return queryToken;
  }

  return null;
}

function rejectUpgrade(socket: Duplex, statusCode: number, message: string): void {
  socket.write(`HTTP/1.1 ${statusCode} ${message}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

export function createGatewayWebSocketServer(deps: WebSocketServerDeps): void {
  const wsServer = new WebSocketServer({ noServer: true });

  deps.server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (url.pathname !== '/ws') {
      rejectUpgrade(socket, 404, 'Not Found');
      return;
    }

    const requestOrigin = getRequestOrigin(request);
    if (deps.allowedOrigins.size > 0 && requestOrigin && !deps.allowedOrigins.has(requestOrigin)) {
      rejectUpgrade(socket, 403, 'Forbidden');
      return;
    }

    const token = getConnectionToken(request, url.searchParams);
    if (!token) {
      rejectUpgrade(socket, 401, 'Unauthorized');
      return;
    }

    let auth;
    try {
      const claims = verifyHs256Jwt(token, deps.jwtSecret);
      auth = buildGatewayAuthContext(claims, url.searchParams);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Invalid auth token';
      rejectUpgrade(socket, 401, message);
      return;
    }

    wsServer.handleUpgrade(request, socket as never, head, (ws: WebSocket) => {
      deps.registry.register(ws, auth);
      wsServer.emit('connection', ws, request);
    });
  });

  wsServer.on('connection', (socket: WebSocket) => {
    let lastSeenAt = Date.now();

    const touch = () => {
      lastSeenAt = Date.now();
    };

    const heartbeat = setInterval(() => {
      if (Date.now() - lastSeenAt > deps.idleTimeoutMs) {
        socket.terminate();
        return;
      }

      if (socket.readyState === socket.OPEN) {
        socket.ping();
      }
    }, Math.max(10_000, Math.floor(deps.idleTimeoutMs / 2)));

    socket.on('pong', touch);

    socket.on('message', async (raw) => {
      touch();

      try {
        const parsed = JSON.parse(raw.toString()) as InboundWsMessage;

        if (!parsed || typeof parsed.type !== 'string') {
          throw new Error('Invalid message envelope');
        }

        const payload = isRecord(parsed.payload) ? parsed.payload : {};
        const auth = deps.registry.getAuthContext(socket);
        if (!auth) {
          throw new Error('Unauthenticated socket context');
        }

        const response =
          (await handleRideMessage(parsed.type, payload, auth, deps.publisher)) ??
          (await handleDriverMessage(parsed.type, payload, auth, deps.publisher)) ??
          (await handleWalletMessage(parsed.type, payload));

        if (!response) {
          deps.registry.sendToSocket(socket, 'error', {
            message: `Unknown event type: ${parsed.type}`,
          });
          return;
        }

        deps.registry.sendToSocket(socket, response.type, response.payload);

      } catch (error) {
        deps.registry.sendToSocket(socket, 'error', {
          message: error instanceof Error ? error.message : 'Unknown message handling error',
        });
      }
    });

    socket.on('close', () => {
      clearInterval(heartbeat);
      deps.registry.unregister(socket);
    });

    socket.on('error', () => {
      clearInterval(heartbeat);
      deps.registry.unregister(socket);
    });
  });
}
