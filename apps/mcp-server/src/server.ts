import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerAccountTools } from './tools/account';
import type { ToolContext } from './tools/common';
import { registerDriverTools } from './tools/driver';
import { registerGroupRideTools } from './tools/group-rides';
import { registerReferralTools } from './tools/referrals';
import { registerRideTools } from './tools/rides';
import { registerScheduledRideTools } from './tools/scheduled';
import { registerWalletTools } from './tools/wallet';

export const SERVER_NAME = 'wheelers';
export const SERVER_VERSION = '0.1.0';

const INSTRUCTIONS = `You are connected to Wheelers, a ride-hailing service in Nigeria, acting on behalf of the signed-in user. All amounts are Nigerian naira (NGN).

Booking a ride:
1. estimate_ride with pickup and destination (addresses are geocoded; if a place is ambiguous you get candidates — ask the user which one).
2. Confirm pickup, destination and the offer price with the user, then request_ride.
3. Drivers bid on the request. Poll list_ride_offers / get_ride_status every ~20–30 seconds and present the bids (price, ETA, rating, vehicle).
4. accept_ride_offer with the chosen driverId (or counter_ride_offer to negotiate). The ride is only confirmed after acceptance.
5. Track with get_ride_status; message the driver with send_ride_message; rate_ride when complete.

Money-moving actions (request_ride, accept_ride_offer, cancel_ride after a match, request_withdrawal) need the user's explicit confirmation first. Never report an action as done unless the tool result says so — surface tool errors verbatim.`;

export function createMcpServer(ctx: ToolContext): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: INSTRUCTIONS },
  );

  registerAccountTools(server, ctx);
  registerRideTools(server, ctx);
  registerScheduledRideTools(server, ctx);
  registerGroupRideTools(server, ctx);
  registerWalletTools(server, ctx);
  registerReferralTools(server, ctx);
  registerDriverTools(server, ctx);

  return server;
}
