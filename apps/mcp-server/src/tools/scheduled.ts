import { randomUUID } from 'crypto';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { guard, LocationSchema, ok, paginationShape, resolveLocation, type ToolContext } from './common';

export function registerScheduledRideTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'schedule_ride',
    {
      title: 'Schedule a ride for later',
      description:
        'Book a ride for a future time (paid from wallet balance). Wheelers dispatches it to drivers ~5 minutes before the scheduled time. Confirm time, pickup and destination with the user first.',
      inputSchema: {
        scheduledFor: z.string().datetime({ offset: true }).describe('ISO-8601 with timezone, e.g. 2026-08-26T07:30:00+01:00.'),
        pickup: LocationSchema,
        destination: LocationSchema,
        stops: z.array(LocationSchema).max(5).optional(),
        useReferralCashback: z.boolean().optional(),
        requestedReferralCashbackNgn: z.number().positive().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) =>
      guard(async () => {
        if (new Date(args.scheduledFor).getTime() <= Date.now() + 60_000) {
          return { isError: true, content: [{ type: 'text', text: 'scheduledFor must be in the future. For a ride right now use request_ride.' }] };
        }
        const pickup = await resolveLocation(ctx, args.pickup, 'Pickup');
        const destination = await resolveLocation(ctx, args.destination, 'Destination');
        const stops = [];
        for (const [index, stop] of (args.stops ?? []).entries()) {
          stops.push(await resolveLocation(ctx, stop, `Stop ${index + 1}`));
        }
        const result = await ctx.gw.post(
          '/scheduled-rides',
          {
            scheduledFor: args.scheduledFor,
            pickup,
            destination,
            stops,
            useReferralCashback: args.useReferralCashback ?? false,
            requestedReferralCashbackNgn: args.requestedReferralCashbackNgn,
          },
          { 'idempotency-key': `mcp-${randomUUID()}` },
        );
        return ok(result);
      }),
  );

  server.registerTool(
    'list_scheduled_rides',
    {
      title: 'List scheduled rides',
      description: 'Upcoming and past scheduled rides with their status.',
      inputSchema: paginationShape,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => guard(async () => ok(await ctx.gw.get('/scheduled-rides', args))),
  );

  server.registerTool(
    'cancel_scheduled_ride',
    {
      title: 'Cancel a scheduled ride',
      description: 'Cancel a scheduled ride that has not been dispatched yet.',
      inputSchema: { scheduledRideId: z.string(), reason: z.string().max(200).optional() },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (args) =>
      guard(async () =>
        ok(await ctx.gw.post(`/scheduled-rides/${encodeURIComponent(args.scheduledRideId)}/cancel`, { reason: args.reason })),
      ),
  );
}
