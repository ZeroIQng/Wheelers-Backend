import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PrismaClient, TransactionType } from '@prisma/client';
import { paymentClient, userClient, walletClient } from '@wheleers/db';

process.env['DATABASE_URL'] ??= 'postgresql://postgres:postgres@localhost:5432/wheelers';

const prisma = new PrismaClient();
const FIAT_ONRAMP_TYPE = TransactionType.CRYPTO_DEPOSIT;

async function main(): Promise<void> {
  const suffix = randomUUID();
  const walletAddress = walletAddressFromUuid(suffix);
  const providerReference = `itest-provider-${suffix}`;
  const secondProviderReference = `itest-provider-2-${suffix}`;
  const rideId = randomUUID();
  const secondRideId = randomUUID();

  const user = await userClient.create({
    privyDid: `did:privy:${suffix}`,
    walletAddress,
    role: 'RIDER',
    name: 'Integration Rider',
  });

  try {
    const wallet = await walletClient.create(user.id, walletAddress);
    await walletClient.credit({
      walletId: wallet.id,
      amountUsdt: 25,
      type: FIAT_ONRAMP_TYPE,
      referenceId: `seed-${suffix}`,
    });

    const firstHold = await walletClient.createRideHold({
      rideId,
      walletId: wallet.id,
      riderId: user.id,
      amountUsdt: 10,
    });
    assert.equal(firstHold.applied, true);

    const duplicateHold = await walletClient.createRideHold({
      rideId,
      walletId: wallet.id,
      riderId: user.id,
      amountUsdt: 10,
    });
    assert.equal(duplicateHold.applied, false);

    const cancelledHold = await walletClient.cancelRideHold(rideId);
    assert.ok(cancelledHold);
    assert.equal(cancelledHold.applied, true);
    assert.equal(cancelledHold.holdAmountUsdt, 10);

    const secondHold = await walletClient.createRideHold({
      rideId: secondRideId,
      walletId: wallet.id,
      riderId: user.id,
      amountUsdt: 12,
    });
    assert.equal(secondHold.applied, true);

    const completedHold = await walletClient.completeRideHold({
      rideId: secondRideId,
      fareUsdt: 11,
    });
    assert.ok(completedHold);
    assert.equal(completedHold.applied, true);

    const duplicateCompletion = await walletClient.completeRideHold({
      rideId: secondRideId,
      fareUsdt: 11,
    });
    assert.ok(duplicateCompletion);
    assert.equal(duplicateCompletion.applied, false);

    const firstCredit = await walletClient.credit({
      walletId: wallet.id,
      amountUsdt: 5,
      type: FIAT_ONRAMP_TYPE,
      referenceId: providerReference,
    });
    assert.equal(firstCredit.applied, true);

    const duplicateCredit = await walletClient.credit({
      walletId: wallet.id,
      amountUsdt: 5,
      type: FIAT_ONRAMP_TYPE,
      referenceId: providerReference,
    });
    assert.equal(duplicateCredit.applied, false);

    await paymentClient.recordSettlementReceived({
      paymentId: randomUUID(),
      userId: user.id,
      provider: 'pouch',
      providerReference,
      userWallet: walletAddress,
      amountLocal: 10000,
      localCurrency: 'NGN',
      metadata: { source: 'integration-test' },
    });

    const firstClaim = await paymentClient.claimSettlement(providerReference);
    const secondClaim = await paymentClient.claimSettlement(providerReference);
    assert.equal(firstClaim, true);
    assert.equal(secondClaim, false);

    await paymentClient.recordSettlementReceived({
      paymentId: randomUUID(),
      userId: user.id,
      provider: 'pouch',
      providerReference: secondProviderReference,
      userWallet: walletAddress,
      amountLocal: 5000,
      localCurrency: 'NGN',
    });

    const claimThenRelease = await paymentClient.claimSettlement(secondProviderReference);
    assert.equal(claimThenRelease, true);
    await paymentClient.releaseSettlementClaim(secondProviderReference);
    const reclaimed = await paymentClient.claimSettlement(secondProviderReference);
    assert.equal(reclaimed, true);

    const paymentRecord = await prisma.paymentRecord.findUniqueOrThrow({
      where: { providerReference },
    });
    assert.equal(paymentRecord.status, 'CONVERTING');

    const finalWallet = await prisma.wallet.findUniqueOrThrow({
      where: { id: wallet.id },
    });
    assert.equal(Number(finalWallet.lockedUsdt), 0);

    console.log('[integration] wallet/payment persistence checks passed');
  } finally {
    await cleanup({
      userId: user.id,
      walletAddress,
      rideIds: [rideId, secondRideId],
      providerReferences: [providerReference, secondProviderReference],
      seedReference: `seed-${suffix}`,
    });
    await prisma.$disconnect();
  }
}

async function cleanup(params: {
  userId: string;
  walletAddress: string;
  rideIds: string[];
  providerReferences: string[];
  seedReference: string;
}): Promise<void> {
  const wallet = await prisma.wallet.findUnique({
    where: { address: params.walletAddress.toLowerCase() },
  });

  if (wallet) {
    await prisma.transaction.deleteMany({
      where: {
        walletId: wallet.id,
        referenceId: {
          in: [params.seedReference, ...params.providerReferences, ...params.rideIds],
        },
      },
    });

    await prisma.rideHold.deleteMany({
      where: {
        rideId: { in: params.rideIds },
      },
    });

    await prisma.wallet.delete({
      where: { id: wallet.id },
    });
  }

  await prisma.paymentRecord.deleteMany({
    where: {
      providerReference: { in: params.providerReferences },
    },
  });

  await prisma.user.delete({
    where: { id: params.userId },
  });
}

function walletAddressFromUuid(id: string): string {
  const hex = id.replace(/-/g, '').slice(0, 40).padEnd(40, '0');
  return `0x${hex}`.toLowerCase();
}

main().catch((error) => {
  console.error('[integration] failed', error);
  process.exit(1);
});
