import { randomUUID } from 'crypto';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { GatewayError } from '../gateway/client';
import { fail, guard, ok, paginationShape, type ToolContext } from './common';

export function registerWalletTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'get_wallet_overview',
    {
      title: 'Wallet balance',
      description: 'Available and locked (held for an active ride) balance in NGN.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => guard(async () => ok(await ctx.gw.get('/wallet/overview'))),
  );

  server.registerTool(
    'get_deposit_details',
    {
      title: 'Bank details for funding the wallet',
      description: 'The user\'s dedicated virtual bank account (bank, account number, name). Any transfer to it credits the Wheelers wallet. If none exists yet, call setup_deposit_account.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () =>
      guard(async () => {
        try {
          return ok(await ctx.gw.get('/wallet/deposit-info'));
        } catch (error) {
          if (error instanceof GatewayError && error.code === 'VIRTUAL_ACCOUNT_NOT_FOUND') {
            return fail(error.message, { code: error.code, hint: 'Call setup_deposit_account to create the user\'s virtual account, then retry.' });
          }
          throw error;
        }
      }),
  );

  server.registerTool(
    'setup_deposit_account',
    {
      title: 'Create deposit (virtual) account',
      description: 'Provision the user\'s dedicated virtual bank account for wallet top-ups. Safe to call repeatedly — returns the existing account if already set up.',
      inputSchema: {},
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async () => guard(async () => ok(await ctx.gw.post('/wallet/provision-virtual-account'))),
  );

  server.registerTool(
    'list_wallet_transactions',
    {
      title: 'Wallet transactions',
      description: 'Credits and debits on the wallet (deposits, ride payments, refunds, withdrawals), newest first.',
      inputSchema: paginationShape,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => guard(async () => ok(await ctx.gw.get('/wallet/transactions', args))),
  );

  server.registerTool(
    'search_banks',
    {
      title: 'Search banks for withdrawal',
      description: 'Find a bank (by name or code, e.g. "GTBank", "OPay", "058") to withdraw to. Returns bankUuid values used by verify_bank_account and request_withdrawal.',
      inputSchema: {
        query: z.string().optional(),
        country: z.string().length(2).optional().describe('ISO country, default NG.'),
        limit: z.number().int().min(1).max(50).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => guard(async () => ok(await ctx.gw.get('/wallet/withdrawals/bank-networks', args))),
  );

  server.registerTool(
    'verify_bank_account',
    {
      title: 'Verify a bank account',
      description: 'Resolve an account number at a bank to the account holder\'s name. Always do this and read the name back to the user before request_withdrawal.',
      inputSchema: {
        accountNumber: z.string().min(6).max(20),
        bankUuid: z.string().describe('From search_banks.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => guard(async () => ok(await ctx.gw.post('/wallet/withdrawals/verify-bank-account', args))),
  );

  server.registerTool(
    'request_withdrawal',
    {
      title: 'Withdraw to bank',
      description:
        'Send money from the Wheelers wallet to a verified bank account. Irreversible. Minimum NGN 5,000; a small payout fee applies. Verify the account first and get the user\'s explicit confirmation of amount and account name.',
      inputSchema: {
        amountNgn: z.number().positive(),
        accountNumber: z.string().min(6).max(20),
        accountName: z.string().min(2).describe('Exactly as returned by verify_bank_account.'),
        bankUuid: z.string(),
        confirm: z.literal(true).describe('Must be true — the user has confirmed the amount and destination.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (args) =>
      guard(async () =>
        ok(
          await ctx.gw.post(
            '/wallet/withdrawals',
            {
              amountNgn: args.amountNgn,
              bankAccount: { accountNumber: args.accountNumber, accountName: args.accountName, bankUuid: args.bankUuid },
            },
            { 'idempotency-key': `mcp-${randomUUID()}` },
          ),
        ),
      ),
  );

  server.registerTool(
    'list_withdrawals',
    {
      title: 'List withdrawals',
      description: 'Past withdrawal requests with status (pending, settled, failed) and failure reasons.',
      inputSchema: paginationShape,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => guard(async () => ok(await ctx.gw.get('/wallet/withdrawals', args))),
  );

  server.registerTool(
    'get_withdrawal',
    {
      title: 'Get a withdrawal',
      description: 'Latest status of one withdrawal (re-synced with the payout provider).',
      inputSchema: { withdrawalId: z.string() },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => guard(async () => ok(await ctx.gw.get(`/wallet/withdrawals/${encodeURIComponent(args.withdrawalId)}`))),
  );
}
