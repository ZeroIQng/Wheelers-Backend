import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { guard, ok, type ToolContext } from './common';

export function registerReferralTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'get_referral_summary',
    {
      title: 'Referral code & cashback summary',
      description: 'The user\'s referral code plus available, frozen, reserved and used cashback balances (NGN) and referral counts.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => guard(async () => ok(await ctx.gw.get('/referrals/me'))),
  );

  server.registerTool(
    'apply_referral_code',
    {
      title: 'Apply a referral code',
      description: 'Redeem someone else\'s referral code on this account (once per account).',
      inputSchema: { code: z.string().min(3) },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => guard(async () => ok(await ctx.gw.post('/referrals/apply', args))),
  );

  server.registerTool(
    'list_my_referrals',
    {
      title: 'People I referred',
      description: 'Riders who used the user\'s code and whether they qualified (took a first ride).',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => guard(async () => ok(await ctx.gw.get('/referrals/me/referrals'))),
  );

  server.registerTool(
    'list_referral_cashback',
    {
      title: 'Referral cashback entries',
      description: 'Individual cashback grants with remaining amounts and freeze/expiry dates.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => guard(async () => ok(await ctx.gw.get('/referrals/me/cashback'))),
  );

  server.registerTool(
    'preview_referral_cashback',
    {
      title: 'Preview cashback on a fare',
      description: 'How much referral cashback would apply to a fare and what the rider would pay.',
      inputSchema: { fareNgn: z.number().positive(), requestedAmountNgn: z.number().positive().optional() },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => guard(async () => ok(await ctx.gw.post('/referrals/me/cashback/ride-preview', args))),
  );
}
