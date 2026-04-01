import { prisma } from '../prisma';

export const paymentClient = {

  // ── Virtual accounts ───────────────────────────────────────────────────────

  createVirtualAccount: (data: {
    walletId:      string;
    bankName:      string;
    accountNumber: string;
    accountName:   string;
    korapayRef:    string;
  }) =>
    prisma.virtualAccount.create({ data }),

  findVirtualAccountByWalletId: (walletId: string) =>
    prisma.virtualAccount.findUnique({ where: { walletId } }),

  // payment-service uses this to look up who sent money when Korapay fires
  // a webhook — korapayRef in the webhook maps to this record.
  findVirtualAccountByKorapayRef: (korapayRef: string) =>
    prisma.virtualAccount.findUnique({
      where:   { korapayRef },
      include: { wallet: true },
    }),

  // ── Transaction lookups ────────────────────────────────────────────────────

  // Check if a payment with this reference has already been processed.
  // Guards against duplicate Korapay webhooks — webhooks can fire more than once.
  findTransactionByReference: (referenceId: string) =>
    prisma.transaction.findFirst({ where: { referenceId } }),

  // Used by payment-service to confirm a deposit was already credited
  // before calling YellowCard — prevents double conversion.
  depositAlreadyProcessed: async (korapayReference: string): Promise<boolean> => {
    const existing = await prisma.transaction.findFirst({
      where: { referenceId: korapayReference },
    });
    return existing !== null;
  },
};