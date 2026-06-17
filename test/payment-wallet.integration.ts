import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PrismaClient, TransactionType } from '@prisma/client';
import { userClient, walletClient } from '@wheleers/db';

process.env['DATABASE_URL'] ??= 'postgresql://postgres:postgres@localhost:5432/wheelers';

const prisma = new PrismaClient();

async function main(): Promise<void> {
  const suffix = randomUUID();
  const providerReference = `itest-provider-${suffix}`;
  const rideId = randomUUID();
  const secondRideId = randomUUID();

  const user = await userClient.create({
    privyDid: `local:${suffix}`,
    role: 'RIDER',
    name: 'Integration Rider',
  });

  // Create a driver user for payout testing
  const driverSuffix = randomUUID();
  const driverUser = await userClient.create({
    privyDid: `local:driver-${driverSuffix}`,
    role: 'DRIVER',
    name: 'Integration Driver',
  });

  try {
    const wallet = await walletClient.create(user.id);
    const driverWallet = await walletClient.create(driverUser.id);

    // Seed rider wallet with 25000 NGN
    await walletClient.credit({
      walletId: wallet.id,
      amountNgn: 25000,
      type: TransactionType.DEPOSIT,
      referenceId: `seed-${suffix}`,
    });

    // ── Ride hold lifecycle ─────────────────────────────────────────────────

    const firstHold = await walletClient.createRideHold({
      rideId,
      walletId: wallet.id,
      riderId: user.id,
      amountNgn: 10000,
    });
    assert.equal(firstHold.applied, true);

    // Duplicate hold should be idempotent
    const duplicateHold = await walletClient.createRideHold({
      rideId,
      walletId: wallet.id,
      riderId: user.id,
      amountNgn: 10000,
    });
    assert.equal(duplicateHold.applied, false);

    // Cancel the first hold
    const cancelledHold = await walletClient.cancelRideHold(rideId);
    assert.ok(cancelledHold);
    assert.equal(cancelledHold.applied, true);
    assert.equal(cancelledHold.holdAmountNgn, 10000);

    // ── Ride completion with driver payout ───────────────────────────────────

    const secondHold = await walletClient.createRideHold({
      rideId: secondRideId,
      walletId: wallet.id,
      riderId: user.id,
      driverUserId: driverUser.id,
      amountNgn: 12000,
    });
    assert.equal(secondHold.applied, true);

    const completedHold = await walletClient.completeRideHoldWithDriverPayout({
      rideId: secondRideId,
      fareNgn: 11000,
      driverUserId: driverUser.id,
    });
    assert.ok(completedHold);
    assert.equal(completedHold.applied, true);

    // Verify driver was credited
    const driverWalletAfter = await prisma.wallet.findUniqueOrThrow({
      where: { id: driverWallet.id },
    });
    assert.equal(Number(driverWalletAfter.balanceNgn), 11000);

    // Duplicate completion should be idempotent
    const duplicateCompletion = await walletClient.completeRideHoldWithDriverPayout({
      rideId: secondRideId,
      fareNgn: 11000,
      driverUserId: driverUser.id,
    });
    assert.ok(duplicateCompletion);
    assert.equal(duplicateCompletion.applied, false);

    // ── Credit / debit idempotency ──────────────────────────────────────────

    const firstCredit = await walletClient.credit({
      walletId: wallet.id,
      amountNgn: 5000,
      type: TransactionType.DEPOSIT,
      referenceId: providerReference,
    });
    assert.equal(firstCredit.applied, true);

    const duplicateCredit = await walletClient.credit({
      walletId: wallet.id,
      amountNgn: 5000,
      type: TransactionType.DEPOSIT,
      referenceId: providerReference,
    });
    assert.equal(duplicateCredit.applied, false);

    // ── Final state verification ────────────────────────────────────────────

    const finalWallet = await prisma.wallet.findUniqueOrThrow({
      where: { id: wallet.id },
    });
    assert.equal(Number(finalWallet.lockedNgn), 0);

    console.log('[integration] wallet/payment persistence checks passed');
  } finally {
    await cleanup({
      userId: user.id,
      driverUserId: driverUser.id,
      rideIds: [rideId, secondRideId],
      providerReferences: [providerReference],
      seedReference: `seed-${suffix}`,
    });
    await prisma.$disconnect();
  }
}

async function cleanup(params: {
  userId: string;
  driverUserId: string;
  rideIds: string[];
  providerReferences: string[];
  seedReference: string;
}): Promise<void> {
  const wallets = await prisma.wallet.findMany({
    where: { userId: { in: [params.userId, params.driverUserId] } },
  });

  for (const wallet of wallets) {
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

  await prisma.user.deleteMany({
    where: { id: { in: [params.userId, params.driverUserId] } },
  });
}

main().catch((error) => {
  console.error('[integration] failed', error);
  process.exit(1);
});
