import { randomUUID } from 'crypto';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { guard, LocationSchema, ok, resolveLocation, type ToolContext } from './common';

export function registerGroupRideTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'request_group_ride',
    {
      title: 'Request a shared (group) ride',
      description:
        'Ask to be matched with other riders heading the same way for a cheaper shared trip. Matching only starts after the rider completes a face-verification selfie in the Wheelers app (required for shared rides); this tool creates the request and tells you that step is pending.',
      inputSchema: {
        pickup: LocationSchema,
        destination: LocationSchema,
        stops: z.array(LocationSchema).max(3).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) =>
      guard(async () => {
        const pickup = await resolveLocation(ctx, args.pickup, 'Pickup');
        const destination = await resolveLocation(ctx, args.destination, 'Destination');
        const stops = [];
        for (const [index, stop] of (args.stops ?? []).entries()) {
          stops.push(await resolveLocation(ctx, stop, `Stop ${index + 1}`));
        }
        const result = await ctx.gw.post<Record<string, unknown>>(
          '/group-rides/requests',
          { pickup, destination, stops },
          { 'idempotency-key': `mcp-${randomUUID()}` },
        );
        return ok({
          ...result,
          nextStep: 'Request created. The user must open the Wheelers app to take the face-verification selfie before matching begins. Track progress with get_group_ride_request.',
        });
      }),
  );

  server.registerTool(
    'list_group_ride_requests',
    {
      title: 'List group ride requests',
      description: 'The user\'s shared-ride match requests and their status.',
      inputSchema: { limit: z.number().int().min(1).max(50).optional() },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => guard(async () => ok(await ctx.gw.get('/group-rides/requests', args))),
  );

  server.registerTool(
    'get_group_ride_request',
    {
      title: 'Get a group ride request',
      description: 'Details of one shared-ride request including matched co-riders once grouped.',
      inputSchema: { requestId: z.string() },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => guard(async () => ok(await ctx.gw.get(`/group-rides/requests/${encodeURIComponent(args.requestId)}`))),
  );

  server.registerTool(
    'cancel_group_ride_request',
    {
      title: 'Cancel a group ride request',
      description: 'Withdraw from a shared-ride match request.',
      inputSchema: { requestId: z.string(), reason: z.string().max(200).optional() },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (args) =>
      guard(async () =>
        ok(await ctx.gw.post(`/group-rides/requests/${encodeURIComponent(args.requestId)}/cancel`, { reason: args.reason })),
      ),
  );
}
