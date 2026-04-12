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

  // Reserved for provider-backed transfer flows where a provider reference
  // must be mapped back to the owning wallet.
  findVirtualAccountByKorapayRef: (korapayRef: string) =>
    prisma.virtualAccount.findUnique({
      where:   { korapayRef },
      include: { wallet: true },
    }),

  // ── Transaction lookups ────────────────────────────────────────────────────

  // Check if a payment with this provider reference has already been processed.
  // Guards against duplicate funding notifications and retries.
  findTransactionByReference: (referenceId: string) =>
    prisma.transaction.findFirst({ where: { referenceId } }),

  // Used by payment-service to confirm a deposit was already credited before
  // emitting a second funding flow.
  depositAlreadyProcessed: async (providerReference: string): Promise<boolean> => {
    const existing = await prisma.transaction.findFirst({
      where: { referenceId: providerReference },
    });
    return existing !== null;
  },
};
