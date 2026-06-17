import { prisma }   from '../prisma';
import { Prisma }   from '@prisma/client';
import type { TransactionType } from '@prisma/client';

// The type of the transactional client Prisma passes into $transaction callbacks
type TxClient = Prisma.TransactionClient;

interface WalletMutationResult {
  wallet: Awaited<ReturnType<typeof prisma.wallet.update>>;
  transaction: Awaited<ReturnType<typeof prisma.transaction.create>>;
  applied: boolean;
}

interface RideHoldMutationResult {
  wallet: Awaited<ReturnType<typeof prisma.wallet.update>>;
  holdAmountNgn: number;
  applied: boolean;
}

interface RideHoldWithPayoutResult {
  riderWallet: Awaited<ReturnType<typeof prisma.wallet.update>>;
  driverWallet: Awaited<ReturnType<typeof prisma.wallet.update>>;
  riderTransaction: Awaited<ReturnType<typeof prisma.transaction.create>>;
  driverTransaction: Awaited<ReturnType<typeof prisma.transaction.create>>;
  holdAmountNgn: number;
  applied: boolean;
}

export const walletClient = {

  // ── Reads ──────────────────────────────────────────────────────────────────

  findByUserId: (userId: string) =>
    prisma.wallet.findUnique({ where: { userId } }),

  findByUserIdOrThrow: (userId: string) =>
    prisma.wallet.findUniqueOrThrow({ where: { userId } }),

  findTransactions: (walletId: string, limit = 30, cursor?: string) =>
    prisma.transaction.findMany({
      where:   { walletId },
      orderBy: { createdAt: 'desc' },
      take:    limit,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    }),

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  create: (userId: string) =>
    prisma.wallet.create({
      data: { userId },
    }),

  // ── Atomic balance operations ──────────────────────────────────────────────

  credit: async (params: {
    walletId:    string;
    amountNgn:   number;
    type:        TransactionType;
    referenceId: string;
    metadata?:   Record<string, unknown>;
  }): Promise<WalletMutationResult> => {
    const { walletId, amountNgn, type, referenceId, metadata } = params;

    try {
      const result = await prisma.$transaction(async (tx: TxClient) => {
        const wallet = await tx.wallet.update({
          where: { id: walletId },
          data:  { balanceNgn: { increment: amountNgn } },
        });

        const txn = await tx.transaction.create({
          data: {
            walletId,
            type,
            direction:      'CREDIT',
            amountNgn,
            balanceAfterNgn: wallet.balanceNgn,
            referenceId,
            metadata:       (metadata ?? undefined) as Prisma.InputJsonValue | undefined,
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
    amountNgn:   number;
    type:        TransactionType;
    referenceId: string;
    metadata?:   Record<string, unknown>;
  }): Promise<WalletMutationResult> => {
    const { walletId, amountNgn, type, referenceId, metadata } = params;

    try {
      const result = await prisma.$transaction(async (tx: TxClient) => {
        const current = await tx.wallet.findUniqueOrThrow({
          where: { id: walletId },
        });

        const available = Number(current.balanceNgn);
        if (available < amountNgn) {
          throw new Error(
            `Insufficient balance on wallet ${walletId}: ` +
            `has ${available} NGN, needs ${amountNgn} NGN`,
          );
        }

        const wallet = await tx.wallet.update({
          where: { id: walletId },
          data:  { balanceNgn: { decrement: amountNgn } },
        });

        const txn = await tx.transaction.create({
          data: {
            walletId,
            type,
            direction:      'DEBIT',
            amountNgn,
            balanceAfterNgn: wallet.balanceNgn,
            referenceId,
            metadata:       (metadata ?? undefined) as Prisma.InputJsonValue | undefined,
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

  lockFunds: (walletId: string, amountNgn: number) =>
    prisma.$transaction(async (tx: TxClient) => {
      const current = await tx.wallet.findUniqueOrThrow({
        where: { id: walletId },
      });

      if (Number(current.balanceNgn) < amountNgn) {
        throw new Error(
          `Cannot lock ${amountNgn} NGN on wallet ${walletId}: ` +
          `only ${current.balanceNgn} available`,
        );
      }

      return tx.wallet.update({
        where: { id: walletId },
        data: {
          balanceNgn: { decrement: amountNgn },
          lockedNgn:  { increment: amountNgn },
        },
      });
    }),

  unlockFunds: (walletId: string, amountNgn: number) =>
    prisma.wallet.update({
      where: { id: walletId },
      data: {
        lockedNgn:  { decrement: amountNgn },
        balanceNgn: { increment: amountNgn },
      },
    }),

  // ── Ride Hold Operations ──────────────────────────────────────────────────

  createRideHold: async (params: {
    rideId: string;
    walletId: string;
    riderId: string;
    driverUserId?: string;
    amountNgn: number;
  }): Promise<RideHoldMutationResult> => {
    const { rideId, walletId, riderId, driverUserId, amountNgn } = params;

    try {
      return await prisma.$transaction(async (tx: TxClient) => {
        const current = await tx.wallet.findUniqueOrThrow({
          where: { id: walletId },
        });

        if (Number(current.balanceNgn) < amountNgn) {
          throw new Error(
            `Cannot lock ${amountNgn} NGN on wallet ${walletId}: ` +
            `only ${current.balanceNgn} available`,
          );
        }

        const wallet = await tx.wallet.update({
          where: { id: walletId },
          data: {
            balanceNgn: { decrement: amountNgn },
            lockedNgn: { increment: amountNgn },
          },
        });

        await tx.rideHold.create({
          data: {
            rideId,
            walletId,
            riderId,
            driverUserId,
            amountNgn,
          },
        });

        return { wallet, holdAmountNgn: amountNgn, applied: true as const };
      });
    } catch (error) {
      if (!isUniqueConstraintError(error)) {
        throw error;
      }

      const wallet = await prisma.wallet.findUniqueOrThrow({ where: { id: walletId } });
      const hold = await prisma.rideHold.findUniqueOrThrow({ where: { rideId } });
      return { wallet, holdAmountNgn: Number(hold.amountNgn), applied: false };
    }
  },

  /**
   * Complete a ride hold: unlock rider's hold, debit rider, credit driver.
   * This is the core ride settlement operation.
   */
  completeRideHoldWithDriverPayout: async (params: {
    rideId: string;
    fareNgn: number;
    driverUserId: string;
  }): Promise<RideHoldWithPayoutResult | null> => {
    const { rideId, fareNgn, driverUserId } = params;

    try {
      return await prisma.$transaction(async (tx: TxClient) => {
        const hold = await tx.rideHold.findUnique({ where: { rideId } });
        if (!hold) return null;
        if (hold.status !== 'ACTIVE') {
          throw new Error(`Ride hold for ${rideId} is not ACTIVE (status: ${hold.status})`);
        }

        // 1. Unlock rider's hold
        const unlockedRiderWallet = await tx.wallet.update({
          where: { id: hold.walletId },
          data: {
            lockedNgn: { decrement: hold.amountNgn },
            balanceNgn: { increment: hold.amountNgn },
          },
        });

        // 2. Debit rider
        if (Number(unlockedRiderWallet.balanceNgn) < fareNgn) {
          throw new Error(
            `Insufficient balance on rider wallet ${hold.walletId} after unlocking: ` +
            `has ${unlockedRiderWallet.balanceNgn} NGN, needs ${fareNgn} NGN`,
          );
        }

        const riderWallet = await tx.wallet.update({
          where: { id: hold.walletId },
          data: { balanceNgn: { decrement: fareNgn } },
        });

        const riderTransaction = await tx.transaction.create({
          data: {
            walletId: hold.walletId,
            type: 'RIDE_PAYMENT',
            direction: 'DEBIT',
            amountNgn: fareNgn,
            balanceAfterNgn: riderWallet.balanceNgn,
            referenceId: rideId,
          },
        });

        // 3. Credit driver
        const driverWallet = await tx.wallet.update({
          where: { userId: driverUserId },
          data: { balanceNgn: { increment: fareNgn } },
        });

        const driverTransaction = await tx.transaction.create({
          data: {
            walletId: driverWallet.id,
            type: 'DRIVER_PAYOUT',
            direction: 'CREDIT',
            amountNgn: fareNgn,
            balanceAfterNgn: driverWallet.balanceNgn,
            referenceId: rideId,
          },
        });

        // 4. Update driver earnings
        await tx.driver.update({
          where: { userId: driverUserId },
          data: { totalEarningsNgn: { increment: fareNgn } },
        });

        // 5. Mark hold as charged
        await tx.rideHold.update({
          where: { rideId },
          data: {
            status: 'CHARGED',
            settledAmountNgn: fareNgn,
            settledAt: new Date(),
          },
        });

        return {
          riderWallet,
          driverWallet,
          riderTransaction,
          driverTransaction,
          holdAmountNgn: Number(hold.amountNgn),
          applied: true as const,
        };
      });
    } catch (error) {
      if (!isUniqueConstraintError(error)) {
        throw error;
      }

      const hold = await prisma.rideHold.findUniqueOrThrow({ where: { rideId } });
      const riderWallet = await prisma.wallet.findUniqueOrThrow({ where: { id: hold.walletId } });
      const driverWallet = await prisma.wallet.findUniqueOrThrow({ where: { userId: driverUserId } });
      const riderTxn = await findExistingTransaction(hold.walletId, 'RIDE_PAYMENT', 'DEBIT', rideId);
      const driverTxn = await findExistingTransaction(driverWallet.id, 'DRIVER_PAYOUT', 'CREDIT', rideId);

      return {
        riderWallet,
        driverWallet,
        riderTransaction: riderTxn,
        driverTransaction: driverTxn,
        holdAmountNgn: Number(hold.amountNgn),
        applied: false,
      };
    }
  },

  adjustRideHold: async (params: {
    rideId: string;
    targetAmountNgn: number;
  }): Promise<(RideHoldMutationResult & { previousHoldAmountNgn: number }) | null> => {
    const { rideId, targetAmountNgn } = params;

    return prisma.$transaction(async (tx: TxClient) => {
      const hold = await tx.rideHold.findUnique({ where: { rideId } });

      if (!hold || hold.status !== 'ACTIVE') {
        if (!hold) return null;
        const wallet = await tx.wallet.findUniqueOrThrow({ where: { id: hold.walletId } });
        return {
          wallet,
          holdAmountNgn: Number(hold.amountNgn),
          previousHoldAmountNgn: Number(hold.amountNgn),
          applied: false as const,
        };
      }

      const currentAmountNgn = Number(hold.amountNgn);
      const normalizedTarget = Math.max(0, targetAmountNgn);
      const deltaNgn = normalizedTarget - currentAmountNgn;

      if (Math.abs(deltaNgn) < 0.01) {
        const wallet = await tx.wallet.findUniqueOrThrow({ where: { id: hold.walletId } });
        return {
          wallet,
          holdAmountNgn: currentAmountNgn,
          previousHoldAmountNgn: currentAmountNgn,
          applied: false as const,
        };
      }

      if (deltaNgn > 0) {
        const wallet = await tx.wallet.findUniqueOrThrow({ where: { id: hold.walletId } });
        if (Number(wallet.balanceNgn) < deltaNgn) {
          throw new Error(
            `Insufficient balance on wallet ${hold.walletId} to adjust ride hold by ${deltaNgn} NGN`,
          );
        }
      }

      const wallet = await tx.wallet.update({
        where: { id: hold.walletId },
        data: {
          balanceNgn: { increment: -deltaNgn },
          lockedNgn: { increment: deltaNgn },
        },
      });

      await tx.rideHold.update({
        where: { rideId },
        data: { amountNgn: normalizedTarget },
      });

      return {
        wallet,
        holdAmountNgn: normalizedTarget,
        previousHoldAmountNgn: currentAmountNgn,
        applied: true as const,
      };
    });
  },

  cancelRideHold: async (rideId: string): Promise<RideHoldMutationResult | null> => {
    return prisma.$transaction(async (tx: TxClient) => {
      const hold = await tx.rideHold.findUnique({ where: { rideId } });

      if (!hold || hold.status !== 'ACTIVE') {
        if (!hold) return null;
        const wallet = await tx.wallet.findUniqueOrThrow({ where: { id: hold.walletId } });
        return { wallet, holdAmountNgn: Number(hold.amountNgn), applied: false as const };
      }

      const wallet = await tx.wallet.update({
        where: { id: hold.walletId },
        data: {
          lockedNgn: { decrement: hold.amountNgn },
          balanceNgn: { increment: hold.amountNgn },
        },
      });

      await tx.rideHold.update({
        where: { rideId },
        data: {
          status: 'RELEASED',
          settledAt: new Date(),
        },
      });

      return { wallet, holdAmountNgn: Number(hold.amountNgn), applied: true as const };
    });
  },
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
