export type GatewayRole = 'RIDER' | 'DRIVER' | 'BOTH';

export interface GatewayAuthContext {
  userId: string;
  privyDid: string;
  walletAddress?: string;
  role: GatewayRole;
  driverId?: string;
  email?: string;
  name?: string;
}

export interface InboundWsMessage {
  type: string;
  payload?: Record<string, unknown>;
}

export interface OutboundWsMessage {
  type: string;
  payload: Record<string, unknown>;
  timestamp: string;
}
