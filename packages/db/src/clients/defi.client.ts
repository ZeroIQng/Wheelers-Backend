import { prisma }  from '../prisma';
import type { DefiProtocol, DefiTier, DefiPositionStatus } from '@prisma/client';

export const defiClient = {

  // ── Positions ──────────────────────────────────────────────────────────────

  createPosition: (data: {
    id:             string;   // UUID from the DEFI_STAKED Kafka event
    walletId:       string;
    protocol:       DefiProtocol;
    tier:           DefiTier;
    stakedUsdt:     number;
    expectedApyPct: number;
    txHash:         string;
    chainId:        number;
  }) =>
    prisma.defiPosition.create({ data }),

  findPositionById: (positionId: string) =>
    prisma.defiPosition.findUniqueOrThrow({ where: { id: positionId } }),

  findActiveByWallet: (walletId: string) =>
    prisma.defiPosition.findMany({
      where:   { walletId, status: 'ACTIVE' },
      orderBy: { createdAt: 'desc' },
    }),

  findAllActivePositions: () =>
    prisma.defiPosition.findMany({
      where:   { status: 'ACTIVE' },
      include: { wallet: true },
    }),

  // defi-scheduler calls this when unstaking begins on-chain.
  markUnstaking: (positionId: string) =>
    prisma.defiPosition.update({
      where: { id: positionId },
      data:  { status: 'UNSTAKING' },
    }),

  // Called when the on-chain unstake transaction confirms.
  closePosition: (positionId: string, unstakeTxHash: string) =>
    prisma.defiPosition.update({
      where: { id: positionId },
      data: {
        status:       'CLOSED',
        unstakeTxHash,
        closedAt:     new Date(),
      },
    }),

  // ── Yield harvests ─────────────────────────────────────────────────────────

  createYieldHarvest: (data: {
    positionId:   string;
    yieldUsdt:    number;
    apyActualPct: number;
    periodDays:   number;
    txHash:       string;
    chainId:      number;
  }) =>
    prisma.yieldHarvest.create({ data }),

  findHarvestsByPosition: (positionId: string) =>
    prisma.yieldHarvest.findMany({
      where:   { positionId },
      orderBy: { harvestedAt: 'desc' },
    }),

  // Total yield earned by a wallet across all positions and harvests.
  totalYieldByWallet: async (walletId: string): Promise<number> => {
    const result = await prisma.yieldHarvest.aggregate({
      where: {
        position: { walletId },
      },
      _sum: { yieldUsdt: true },
    });
    return Number(result._sum.yieldUsdt ?? 0);
  },

  // ── Idle detection helper ──────────────────────────────────────────────────

  // defi-scheduler uses this to find wallets that have been idle
  // (no ride activity, no recent debit) for over idleHours.
  findIdleWallets: (thresholdUsdt: number, idleHours: number) => {
    const idleSince = new Date(Date.now() - idleHours * 60 * 60 * 1000);
    return prisma.wallet.findMany({
      where: {
        balanceUsdt: { gte: thresholdUsdt },
        // No transactions in the idle window
        transactions: {
          none: {
            createdAt:  { gte: idleSince },
            direction:  'DEBIT',
          },
        },
        // No active DeFi position already (no double-staking)
        defiPositions: {
          none: { status: 'ACTIVE' },
        },
      },
      include: { user: true },
    });
  },
};