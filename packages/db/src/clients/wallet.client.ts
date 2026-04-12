import { prisma }   from '../prisma';
import { Prisma }   from '@prisma/client';
import type { TransactionType, PrismaClient } from '@prisma/client';

// The type of the transactional client Prisma passes into $transaction callbacks
type TxClient = Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>;

interface WalletMutationResult {
  wallet: Awaited<ReturnType<typeof prisma.wallet.update>>;
  transaction: Awaited<ReturnType<typeof prisma.transaction.create>>;
  applied: boolean;
}

export const walletClient = {

  // ── Reads ──────────────────────────────────────────────────────────────────

  findByUserId: (userId: string) =>
    prisma.wallet.findUniqueOrThrow({ where: { userId } }),

  findByAddress: (address: string) =>
    prisma.wallet.findUniqueOrThrow({
      where: { address: address.toLowerCase() },
    }),

  findTransactions: (walletId: string, limit = 30, cursor?: string) =>
    prisma.transaction.findMany({
      where:   { walletId },
      orderBy: { createdAt: 'desc' },
      take:    limit,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    }),

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  create: (userId: string, address: string, chain = 'base') =>
    prisma.wallet.create({
      data: { userId, address: address.toLowerCase(), chain },
    }),

  // ── Atomic balance operations ──────────────────────────────────────────────
  // All balance changes run inside a Prisma $transaction so the wallet row
  // and the transaction ledger row are always written together or not at all.

  credit: async (params: {
    walletId:    string;
    amountUsdt:  number;
    type:        TransactionType;
    referenceId: string;
    metadata?:   Record<string, unknown>;
  }): Promise<WalletMutationResult> => {
    const { walletId, amountUsdt, type, referenceId, metadata } = params;

    try {
      const result = await prisma.$transaction(async (tx: TxClient) => {
        const wallet = await tx.wallet.update({
          where: { id: walletId },
          data:  { balanceUsdt: { increment: amountUsdt } },
        });

        const txn = await tx.transaction.create({
          data: {
            walletId,
            type,
            direction:    'CREDIT',
            amountUsdt,
            balanceAfter: wallet.balanceUsdt,
            referenceId,
            metadata:     (metadata ?? undefined) as Prisma.InputJsonValue | undefined,
          },
        });

        return { wallet, transaction: txn, applied: true as const };
      });

      return result;
    } catch (error) {
      if (!isUniqueConstraintError(error)) {
        throw error;
      }

      const existing = await findExistingTransaction(walletId, type, 'CREDIT', referenceId);
      const wallet = await prisma.wallet.findUniqueOrThrow({ where: { id: walletId } });

      return {
        wallet,
        transaction: existing,
        applied: false,
      };
    }
  },

  debit: async (params: {
    walletId:    string;
    amountUsdt:  number;
    type:        TransactionType;
    referenceId: string;
    metadata?:   Record<string, unknown>;
  }): Promise<WalletMutationResult> => {
    const { walletId, amountUsdt, type, referenceId, metadata } = params;

    try {
      const result = await prisma.$transaction(async (tx: TxClient) => {
        const current = await tx.wallet.findUniqueOrThrow({
          where: { id: walletId },
        });

        const available = Number(current.balanceUsdt);
        if (available < amountUsdt) {
          throw new Error(
            `Insufficient balance on wallet ${walletId}: ` +
            `has ${available} USDT, needs ${amountUsdt} USDT`,
          );
        }

        const wallet = await tx.wallet.update({
          where: { id: walletId },
          data:  { balanceUsdt: { decrement: amountUsdt } },
        });

        const txn = await tx.transaction.create({
          data: {
            walletId,
            type,
            direction:    'DEBIT',
            amountUsdt,
            balanceAfter: wallet.balanceUsdt,
            referenceId,
            metadata:     (metadata ?? undefined) as Prisma.InputJsonValue | undefined,
          },
        });

        return { wallet, transaction: txn, applied: true as const };
      });

      return result;
    } catch (error) {
      if (!isUniqueConstraintError(error)) {
        throw error;
      }

      const existing = await findExistingTransaction(walletId, type, 'DEBIT', referenceId);
      const wallet = await prisma.wallet.findUniqueOrThrow({ where: { id: walletId } });

      return {
        wallet,
        transaction: existing,
        applied: false,
      };
    }
  },

  lockFunds: (walletId: string, amountUsdt: number) =>
    prisma.$transaction(async (tx: TxClient) => {
      const current = await tx.wallet.findUniqueOrThrow({
        where: { id: walletId },
      });

      if (Number(current.balanceUsdt) < amountUsdt) {
        throw new Error(
          `Cannot lock ${amountUsdt} USDT on wallet ${walletId}: ` +
          `only ${current.balanceUsdt} available`,
        );
      }

      return tx.wallet.update({
        where: { id: walletId },
        data: {
          balanceUsdt: { decrement: amountUsdt },
          lockedUsdt:  { increment: amountUsdt },
        },
      });
    }),

  unlockFunds: (walletId: string, amountUsdt: number) =>
    prisma.wallet.update({
      where: { id: walletId },
      data: {
        lockedUsdt:  { decrement: amountUsdt },
        balanceUsdt: { increment: amountUsdt },
      },
    }),

  moveToStaked: (walletId: string, amountUsdt: number) =>
    prisma.$transaction(async (tx: TxClient) => {
      const current = await tx.wallet.findUniqueOrThrow({
        where: { id: walletId },
      });

      if (Number(current.balanceUsdt) < amountUsdt) {
        throw new Error(
          `Cannot stake ${amountUsdt} USDT on wallet ${walletId}: ` +
          `only ${current.balanceUsdt} available`,
        );
      }

      return tx.wallet.update({
        where: { id: walletId },
        data: {
          balanceUsdt: { decrement: amountUsdt },
          stakedUsdt:  { increment: amountUsdt },
        },
      });
    }),

  moveFromStaked: (walletId: string, amountUsdt: number) =>
    prisma.wallet.update({
      where: { id: walletId },
      data: {
        stakedUsdt:  { decrement: amountUsdt },
        balanceUsdt: { increment: amountUsdt },
      },
    }),
};

async function findExistingTransaction(
  walletId: string,
  type: TransactionType,
  direction: 'CREDIT' | 'DEBIT',
  referenceId: string,
) {
  return prisma.transaction.findFirstOrThrow({
    where: {
      walletId,
      type,
      direction,
      referenceId,
    },
  });
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  );
}
