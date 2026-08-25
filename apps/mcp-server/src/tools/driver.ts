import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { guard, ok, paginationShape, type ToolContext } from './common';

/**
 * Driver-side reads. Going online, accepting rides and streaming GPS are done
 * from the driver app (they need a live location), so they are not exposed.
 */
export function registerDriverTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'get_driver_stats',
    {
      title: 'Driver profile & stats',
      description: 'For driver accounts: status, KYC state, rating, total rides, lifetime earnings, vehicle and wallet balance. Returns 404 for rider-only accounts.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => guard(async () => ok(await ctx.gw.get('/drivers/me/stats'))),
  );

  server.registerTool(
    'get_driver_earnings',
    {
      title: 'Driver earnings',
      description: 'Earnings for today, this week or this month with the individual payouts.',
      inputSchema: { period: z.enum(['today', 'week', 'month']).optional() },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => guard(async () => ok(await ctx.gw.get('/drivers/me/earnings', args))),
  );

  server.registerTool(
    'get_driver_ride_history',
    {
      title: 'Driver ride history',
      description: 'Trips driven, newest first.',
      inputSchema: paginationShape,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => guard(async () => ok(await ctx.gw.get('/drivers/me/rides/history', args))),
  );

  server.registerTool(
    'get_driver_kyc_status',
    {
      title: 'Driver KYC status',
      description: 'Driver onboarding/KYC review status, rejection reasons and submitted vehicle details. Documents are submitted from the driver app.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => guard(async () => ok(await ctx.gw.get('/drivers/kyc/status'))),
  );
}
