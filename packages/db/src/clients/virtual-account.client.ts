import { prisma } from '../prisma';

export const virtualAccountClient = {

  findByUserId: (userId: string) =>
    prisma.virtualAccount.findUnique({ where: { userId } }),

  findByPouchVirtualAccountId: (pouchVirtualAccountId: string) =>
    prisma.virtualAccount.findUnique({ where: { pouchVirtualAccountId } }),

  findByAccountNumber: (accountNumber: string) =>
    prisma.virtualAccount.findFirst({ where: { accountNumber } }),

  create: (data: {
    userId: string;
    pouchCustomerId: string;
    pouchVirtualAccountId: string;
    bankName: string;
    accountNumber: string;
    accountName: string;
    currency?: string;
    country?: string;
  }) =>
    prisma.virtualAccount.create({
      data: {
        userId: data.userId,
        pouchCustomerId: data.pouchCustomerId,
        pouchVirtualAccountId: data.pouchVirtualAccountId,
        bankName: data.bankName,
        accountNumber: data.accountNumber,
        accountName: data.accountName,
        currency: data.currency ?? 'NGN',
        country: data.country ?? 'NG',
      },
    }),

  updateStatus: (userId: string, status: string) =>
    prisma.virtualAccount.update({
      where: { userId },
      data: { status },
    }),
};
