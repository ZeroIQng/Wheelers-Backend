import { randomUUID } from 'crypto';
import type WebSocket from 'ws';
import type { GatewayAuthContext, OutboundWsMessage } from '../types';
import { isRecord } from '../utils/object';
import { RedisClient } from '../redis/client';

const REGISTRY_TTL_SECONDS = 60 * 60 * 24;

interface RemoteSocketMessage {
  userId: string;
  type: string;
  payload: Record<string, unknown>;
  timestamp: string;
}

function userSocketsKey(userId: string): string {
  return `gateway:user:${userId}:sockets`;
}

function userInstancesKey(userId: string): string {
  return `gateway:user:${userId}:instances`;
}

function socketMetadataKey(connectionId: string): string {
  return `gateway:socket:${connectionId}`;
}

function instanceChannel(instanceId: string): string {
  return `gateway:instance:${instanceId}`;
}

interface SocketRegistryDeps {
  instanceId: string;
  commandRedis: RedisClient;
  subscriberRedis: RedisClient;
}

export class SocketRegistry {
  private socketsByConnectionId = new Map<string, WebSocket>();
  private connectionIdBySocket = new Map<WebSocket, string>();
  private connectionsByUser = new Map<string, Set<string>>();
  private authBySocket = new Map<WebSocket, GatewayAuthContext>();

  constructor(private readonly deps: SocketRegistryDeps) {}

  async start(): Promise<void> {
    this.deps.subscriberRedis.onMessage((_channel, payload) => {
      void this.handleRemoteMessage(payload);
    });

    await this.deps.subscriberRedis.subscribe(instanceChannel(this.deps.instanceId));
  }

  async register(socket: WebSocket, auth: GatewayAuthContext): Promise<void> {
    const connectionId = randomUUID();

    this.socketsByConnectionId.set(connectionId, socket);
    this.connectionIdBySocket.set(socket, connectionId);
    this.authBySocket.set(socket, auth);

    const userConnections = this.connectionsByUser.get(auth.userId) ?? new Set<string>();
    userConnections.add(connectionId);
    this.connectionsByUser.set(auth.userId, userConnections);

    await Promise.all([
      this.deps.commandRedis.sadd(userSocketsKey(auth.userId), connectionId),
      this.deps.commandRedis.sadd(userInstancesKey(auth.userId), this.deps.instanceId),
      this.deps.commandRedis.set(
        socketMetadataKey(connectionId),
        JSON.stringify({ userId: auth.userId, instanceId: this.deps.instanceId }),
        REGISTRY_TTL_SECONDS,
      ),
    ]);
  }

  async unregister(socket: WebSocket): Promise<void> {
    const connectionId = this.connectionIdBySocket.get(socket);
    const auth = this.authBySocket.get(socket);
    if (!connectionId || !auth) return;

    this.connectionIdBySocket.delete(socket);
    this.authBySocket.delete(socket);
    this.socketsByConnectionId.delete(connectionId);

    const userConnections = this.connectionsByUser.get(auth.userId);
    if (userConnections) {
      userConnections.delete(connectionId);
      if (userConnections.size === 0) {
        this.connectionsByUser.delete(auth.userId);
      }
    }

    await Promise.all([
      this.deps.commandRedis.srem(userSocketsKey(auth.userId), connectionId),
      this.deps.commandRedis.del(socketMetadataKey(connectionId)),
      userConnections && userConnections.size === 0
        ? this.deps.commandRedis.srem(userInstancesKey(auth.userId), this.deps.instanceId)
        : Promise.resolve(),
    ]);
  }

  getAuthContext(socket: WebSocket): GatewayAuthContext | undefined {
    return this.authBySocket.get(socket);
  }

  sendToSocket(socket: WebSocket, type: string, payload: Record<string, unknown>): void {
    if (socket.readyState !== socket.OPEN) return;

    const message: OutboundWsMessage = {
      type,
      payload,
      timestamp: new Date().toISOString(),
    };

    socket.send(JSON.stringify(message));
  }

  async sendToUser(userId: string, type: string, payload: Record<string, unknown>): Promise<void> {
    this.sendToLocalUser(userId, type, payload, new Date().toISOString());

    const instances = await this.deps.commandRedis.smembers(userInstancesKey(userId));
    const remoteInstances = instances.filter((instanceId) => instanceId !== this.deps.instanceId);

    if (remoteInstances.length === 0) {
      return;
    }

    const message: RemoteSocketMessage = {
      userId,
      type,
      payload,
      timestamp: new Date().toISOString(),
    };

    const serialized = JSON.stringify(message);

    await Promise.all(
      remoteInstances.map((instanceId) =>
        this.deps.commandRedis.publish(instanceChannel(instanceId), serialized),
      ),
    );
  }

  private sendToLocalUser(
    userId: string,
    type: string,
    payload: Record<string, unknown>,
    timestamp: string,
  ): void {
    const userConnectionIds = this.connectionsByUser.get(userId);
    if (!userConnectionIds || userConnectionIds.size === 0) return;

    const outbound: OutboundWsMessage = {
      type,
      payload,
      timestamp,
    };

    const serialized = JSON.stringify(outbound);

    for (const connectionId of userConnectionIds) {
      const socket = this.socketsByConnectionId.get(connectionId);
      if (!socket || socket.readyState !== socket.OPEN) continue;
      socket.send(serialized);
    }
  }

  private async handleRemoteMessage(payload: string): Promise<void> {
    try {
      const parsed = JSON.parse(payload);
      if (!isRecord(parsed)) return;

      const userId = typeof parsed['userId'] === 'string' ? parsed['userId'] : undefined;
      const type = typeof parsed['type'] === 'string' ? parsed['type'] : undefined;
      const timestamp = typeof parsed['timestamp'] === 'string' ? parsed['timestamp'] : undefined;
      const data = isRecord(parsed['payload']) ? parsed['payload'] : undefined;

      if (!userId || !type || !timestamp || !data) {
        return;
      }

      this.sendToLocalUser(userId, type, data, timestamp);
    } catch {
      // ignore malformed relay messages
    }
  }
}
