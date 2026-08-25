import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { guard, ok, type ToolContext } from './common';

export function registerAccountTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'get_my_profile',
    {
      title: 'Get my Wheelers profile',
      description: 'Returns the signed-in user: id, name, username, email, phone and role (RIDER, DRIVER or BOTH). Call this first to know who you are acting for.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => guard(async () => ok(await ctx.gw.get('/auth/me'))),
  );

  server.registerTool(
    'update_my_profile',
    {
      title: 'Update my profile',
      description: 'Update name, username, email or phone on the Wheelers account. Only provided fields change.',
      inputSchema: {
        fullName: z.string().min(2).max(80).optional(),
        username: z.string().regex(/^[a-z0-9_]{3,24}$/, 'lowercase letters, digits, underscore; 3–24 chars').optional(),
        email: z.string().email().optional(),
        phone: z.string().min(7).max(24).optional().describe('E.164 preferred, e.g. +2348012345678'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => guard(async () => ok(await ctx.gw.put('/auth/profile', args))),
  );

  server.registerTool(
    'get_notifications',
    {
      title: 'List notifications',
      description: 'Recent in-app notifications (ride updates, wallet credits, promos) with read/unread state.',
      inputSchema: {
        limit: z.number().int().min(1).max(100).optional().describe('Default 50, max 100.'),
        unreadOnly: z.boolean().optional().describe('Filter to unread notifications only.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) =>
      guard(async () => {
        const result = await ctx.gw.get<{ items: Array<{ read: boolean }> }>('/notifications', { limit: args.limit });
        const items = args.unreadOnly ? result.items.filter((item) => !item.read) : result.items;
        return ok({ items, unreadCount: result.items.filter((item) => !item.read).length });
      }),
  );

  server.registerTool(
    'mark_notifications_read',
    {
      title: 'Mark notifications read',
      description: 'Mark specific notifications as read, or all of them when notificationIds is omitted.',
      inputSchema: {
        notificationIds: z.array(z.string()).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) =>
      guard(async () => ok(await ctx.gw.post('/notifications/read', { notificationIds: args.notificationIds ?? [] }))),
  );

  server.registerTool(
    'get_rider_kyc_status',
    {
      title: 'Get rider verification status',
      description: 'Rider identity (KYC/face) verification status. Verification is optional for riders; it is completed in the Wheelers app, not here.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => guard(async () => ok(await ctx.gw.get('/kyc/status'))),
  );
}
