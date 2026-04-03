import type WebSocket from 'ws';
import type { GatewayAuthContext, OutboundWsMessage } from '../types';

export class SocketRegistry {
  private socketsByUser = new Map<string, Set<WebSocket>>();
  private authBySocket = new Map<WebSocket, GatewayAuthContext>();

  register(socket: WebSocket, auth: GatewayAuthContext): void {
    const existing = this.socketsByUser.get(auth.userId) ?? new Set<WebSocket>();
    existing.add(socket);
    this.socketsByUser.set(auth.userId, existing);
    this.authBySocket.set(socket, auth);
  }

  unregister(socket: WebSocket): void {
    const auth = this.authBySocket.get(socket);
    if (!auth) return;

    const userSockets = this.socketsByUser.get(auth.userId);
    if (!userSockets) return;

    userSockets.delete(socket);
    this.authBySocket.delete(socket);

    if (userSockets.size === 0) {
      this.socketsByUser.delete(auth.userId);
    }
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

  sendToUser(userId: string, type: string, payload: Record<string, unknown>): void {
    const userSockets = this.socketsByUser.get(userId);
    if (!userSockets || userSockets.size === 0) return;

    for (const socket of userSockets) {
      this.sendToSocket(socket, type, payload);
    }
  }
}
