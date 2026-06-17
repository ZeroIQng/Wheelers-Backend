import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../prisma';

type TxClient = Prisma.TransactionClient;

function asJson(value: Record<string, unknown> | undefined) {
  return (value ?? undefined) as Prisma.InputJsonValue | undefined;
}

export const withdrawalClient = {
  reserve: async (input: {
    userId: string;
    walletId: string;
    amountNgn: number;
    bankAccountNumber: string;
    bankAccountName: string;
    bankNetworkId: string;
  }) =>
    prisma.$transaction(async (tx: TxClient) => {
      const wallet = await tx.wallet.findUniqueOrThrow({
        where: { id: input.walletId },
      });

      const availableNgn = Number(wallet.balanceNgn);
      if (availableNgn < input.amountNgn) {
        throw new Error('You have insufficient balance for this withdrawal.');
      }

      const withdrawalId = randomUUID();
      const reservationId = randomUUID();

      const updatedWallet = await tx.wallet.update({
        where: { id: input.walletId },
        data: {
          balanceNgn: { decrement: input.amountNgn },
          lockedNgn: { increment: input.amountNgn },
        },
      });

      const reservation = await tx.walletReservation.create({
        data: {
          id: reservationId,
          walletId: input.walletId,
          userId: input.userId,
          kind: 'WITHDRAWAL',
          status: 'ACTIVE',
          amountNgn: input.amountNgn,
          referenceId: withdrawalId,
        },
      });

      const request = await tx.withdrawalRequest.create({
        data: {
          id: withdrawalId,
          userId: input.userId,
          walletId: input.walletId,
          reservationId,
          status: 'FUNDS_RESERVED',
          requestedAmountNgn: input.amountNgn,
          reservedAmountNgn: input.amountNgn,
          bankAccountNumber: input.bankAccountNumber,
          bankAccountName: input.bankAccountName,
          bankNetworkId: input.bankNetworkId,
        },
      });

      return {
        wallet: updatedWallet,
        reservation,
        request,
      };
    }),

  attachPayout: async (input: {
    withdrawalRequestId: string;
    pouchPayoutId: string;
    providerReference: string;
    providerPayload?: Record<string, unknown>;
    expiresAt?: Date;
  }) =>
    prisma.withdrawalRequest.update({
      where: { id: input.withdrawalRequestId },
      data: {
        pouchPayoutId: input.pouchPayoutId,
        providerReference: input.providerReference,
        providerPayload: asJson(input.providerPayload),
        expiresAt: input.expiresAt,
        status: 'PAYOUT_CREATED',
      },
    }),

  markProcessing: async (providerReference: string) =>
    prisma.withdrawalRequest.updateMany({
      where: {
        providerReference,
        status: {
          in: ['FUNDS_RESERVED', 'PAYOUT_CREATED', 'PENDING'],
        },
      },
      data: {
        status: 'PROCESSING',
      },
    }),

  releaseFailedRequest: async (params: {
    withdrawalRequestId?: string;
    providerReference?: string;
    failureReason: string;
    status: 'FAILED' | 'EXPIRED' | 'CANCELLED';
  }) =>
    prisma.$transaction(async (tx: TxClient) => {
      const request = await tx.withdrawalRequest.findFirst({
        where: params.withdrawalRequestId
          ? { id: params.withdrawalRequestId }
          : { providerReference: params.providerReference },
        include: {
          reservation: true,
          wallet: true,
        },
      });

      if (!request) {
        return null;
      }

      if (request.status === 'SETTLED') {
        return request;
      }

      if (request.reservation.status === 'ACTIVE') {
        await tx.wallet.update({
          where: { id: request.walletId },
          data: {
            balanceNgn: { increment: Number(request.reservedAmountNgn) },
            lockedNgn: { decrement: Number(request.reservedAmountNgn) },
          },
        });

        await tx.walletReservation.update({
          where: { id: request.reservationId },
          data: {
            status: 'RELEASED',
            releasedAt: new Date(),
          },
        });
      }

      return tx.withdrawalRequest.update({
        where: { id: request.id },
        data: {
          status: params.status,
          failureReason: params.failureReason,
          failedAt: new Date(),
          releasedAt: new Date(),
        },
      });
    }),

  settle: async (providerReference: string) =>
    prisma.$transaction(async (tx: TxClient) => {
      const request = await tx.withdrawalRequest.findFirst({
        where: { providerReference },
        include: {
          reservation: true,
          wallet: true,
        },
      });

      if (!request) {
        return null;
      }

      if (request.status === 'SETTLED') {
        return request;
      }

      if (request.reservation.status !== 'ACTIVE') {
        throw new Error('Withdrawal reservation is not active.');
      }

      const wallet = await tx.wallet.update({
        where: { id: request.walletId },
        data: {
          lockedNgn: { decrement: request.reservedAmountNgn },
        },
      });

      await tx.transaction.create({
        data: {
          walletId: request.walletId,
          type: 'WITHDRAWAL',
          direction: 'DEBIT',
          amountNgn: request.reservedAmountNgn,
          balanceAfterNgn: wallet.balanceNgn,
          referenceId: request.id,
          metadata: asJson({
            providerReference: request.providerReference,
            pouchPayoutId: request.pouchPayoutId,
            bankNetworkId: request.bankNetworkId,
          }),
        },
      });

      await tx.walletReservation.update({
        where: { id: request.reservationId },
        data: {
          status: 'CONSUMED',
          consumedAt: new Date(),
        },
      });

      return tx.withdrawalRequest.update({
        where: { id: request.id },
        data: {
          status: 'SETTLED',
          settledAt: new Date(),
          failureReason: null,
        },
      });
    }),

  listByUser: (userId: string, limit = 20, cursor?: string) =>
    prisma.withdrawalRequest.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: limit,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    }),

  findById: (id: string) =>
    prisma.withdrawalRequest.findUnique({
      where: { id },
    }),

  findByProviderReference: (providerReference: string) =>
    prisma.withdrawalRequest.findUnique({
      where: { providerReference },
    }),
};
