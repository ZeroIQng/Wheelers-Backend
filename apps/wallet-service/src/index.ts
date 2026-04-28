import { validateSharedEnv, validateWalletEnv } from '@wheleers/config';
import { walletClient } from '@wheleers/db';
import { createConsumer, createProducer } from '@wheleers/kafka-client';
import { safeParseKafkaEvent, TOPICS } from '@wheleers/kafka-schemas';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';

const SERVICE_ID = 'wallet-service';

bootstrap().catch((err) => {
  console.error(`[${SERVICE_ID}] fatal`, err);
  process.exit(1);
});

async function bootstrap(): Promise<void> {
  process.env['NODE_ENV'] ??= 'development';
  process.env['KAFKA_CLIENT_ID'] ??= SERVICE_ID;
  process.env['KAFKA_BROKERS'] ??= 'localhost:9092';
  process.env['DATABASE_URL'] ??= 'postgresql://postgres:postgres@localhost:5432/wheelers';
  process.env['REDIS_URL'] ??= 'redis://localhost:6379';

  // Dev placeholders for required wallet env
  process.env['PLATFORM_PRIVATE_KEY'] ??= 'dev';
  process.env['RPC_URL_BASE'] ??= 'http://localhost:8545';

  validateSharedEnv();
  validateWalletEnv();

  const producer = await createProducer({ serviceId: SERVICE_ID });
  const consumer = await createConsumer({ groupId: SERVICE_ID });

  await consumer.subscribe(
    [TOPICS.USER_EVENTS, TOPICS.RIDE_EVENTS, TOPICS.PAYMENT_EVENTS, TOPICS.DEFI_EVENTS],
    async (value, ctx) => {
      if (ctx.topic === TOPICS.USER_EVENTS) {
        const event = safeParseKafkaEvent(TOPICS.USER_EVENTS, value);
        if (!event) return;

        if (
          event.eventType === 'USER_CREATED' ||
          event.eventType === 'USER_WALLET_LINKED'
        ) {
          if (!event.walletAddress) {
            return;
          }

          try {
            await walletClient.create(event.userId, event.walletAddress);
          } catch (err) {
            if (isUniqueConstraintError(err)) {
              return;
            }

            throw err;
          }
        }

        return;
      }

      if (ctx.topic === TOPICS.RIDE_EVENTS) {
        const event = safeParseKafkaEvent(TOPICS.RIDE_EVENTS, value);
        if (!event) return;

        if (event.eventType === 'RIDE_DRIVER_ASSIGNED') {
          try {
            const wallet = await walletClient.findByUserId(event.riderId);
            const holdResult = await walletClient.createRideHold({
              rideId: event.rideId,
              walletId: wallet.id,
              riderId: event.riderId,
              amountUsdt: event.lockedFareUsdt,
            });

            if (!holdResult.applied) {
              return;
            }

            await producer.send(TOPICS.WALLET_EVENTS, {
              eventType: 'WALLET_LOCKED',
              walletId: holdResult.wallet.id,
              userId: holdResult.wallet.userId,
              walletAddress: holdResult.wallet.address,
              lockedAmountUsdt: event.lockedFareUsdt,
              rideId: event.rideId,
              reason: 'ride_fare_hold',
              timestamp: new Date().toISOString(),
            } as any, { key: event.rideId });
          } catch (err) {
            console.warn(`[${SERVICE_ID}] lock failed:`, (err as any)?.message ?? err);
          }
        }

        if (event.eventType === 'RIDE_COMPLETED') {
          try {
            const holdResult = await walletClient.completeRideHold({
              rideId: event.rideId,
              fareUsdt: event.fareUsdt,
            });

            if (!holdResult || !holdResult.applied) {
              return;
            }

            const riderWallet = await walletClient.findByUserId(event.riderId);

            await producer.send(TOPICS.WALLET_EVENTS, {
              eventType: 'WALLET_DEBITED',
              walletId: holdResult.wallet.id,
              userId: riderWallet.userId,
              walletAddress: riderWallet.address,
              amountUsdt: event.fareUsdt,
              newBalanceUsdt: Number(holdResult.wallet.balanceUsdt),
              debitType: 'ride_payment',
              referenceId: event.rideId,
              timestamp: new Date().toISOString(),
            } as any, { key: event.rideId });
          } catch (err) {
            console.warn(`[${SERVICE_ID}] ride debit failed:`, (err as any)?.message ?? err);
          }
        }

        if (event.eventType === 'RIDE_CANCELLED') {
          try {
            const holdResult = await walletClient.cancelRideHold(event.rideId);
            if (!holdResult || !holdResult.applied) {
              return;
            }

            const wallet = await walletClient.findByUserId(event.riderId);
            await producer.send(TOPICS.WALLET_EVENTS, {
              eventType: 'WALLET_UNLOCKED',
              walletId: holdResult.wallet.id,
              userId: wallet.userId,
              walletAddress: wallet.address,
              unlockedAmountUsdt: holdResult.holdAmountUsdt,
              rideId: event.rideId,
              reason: 'ride_cancelled',
              timestamp: new Date().toISOString(),
            } as any, { key: event.rideId });
          } catch (err) {
            console.warn(`[${SERVICE_ID}] unlock failed:`, (err as any)?.message ?? err);
          }
        }

        return;
      }

      if (ctx.topic === TOPICS.PAYMENT_EVENTS) {
        const event = safeParseKafkaEvent(TOPICS.PAYMENT_EVENTS, value);
        if (!event) return;

        if (event.eventType === 'ONRAMP_SETTLED') {
          try {
            const wallet = await walletClient.findByAddress(event.userWallet);
            const creditResult = await walletClient.credit({
              walletId: wallet.id,
              amountUsdt: event.amountUsdt,
              type: 'FIAT_ONRAMP' as any,
              referenceId: event.providerReference,
              metadata: {
                paymentId: event.paymentId,
                paymentProvider: event.paymentProvider,
                amountUsd: event.amountUsd,
                localCurrency: event.localCurrency,
                amountLocal: event.amountLocal,
                cryptoCurrency: event.cryptoCurrency,
                cryptoNetwork: event.cryptoNetwork,
                settlementReference: event.settlementReference,
              },
            });

            if (!creditResult.applied) {
              return;
            }

            await producer.send(TOPICS.WALLET_EVENTS, {
              eventType: 'WALLET_CREDITED',
              walletId: creditResult.wallet.id,
              userId: creditResult.wallet.userId,
              walletAddress: creditResult.wallet.address,
              amountUsdt: event.amountUsdt,
              newBalanceUsdt: Number(creditResult.wallet.balanceUsdt),
              creditType: 'fiat_onramp',
              referenceId: event.providerReference,
              timestamp: new Date().toISOString(),
            } as any, { key: event.userId });
          } catch (err) {
            console.warn(`[${SERVICE_ID}] credit failed:`, (err as any)?.message ?? err);
            throw err;
          }
        }

        if (event.eventType === 'CRYPTO_DEPOSIT_RECEIVED') {
          try {
            const wallet = await walletClient.findByAddress(event.userWallet);
            const creditResult = await walletClient.credit({
              walletId: wallet.id,
              amountUsdt: event.amountUsdt,
              type: 'CRYPTO_DEPOSIT' as any,
              referenceId: event.paymentId,
              metadata: { txHash: event.txHash, chainId: event.chainId },
            });

            if (!creditResult.applied) {
              return;
            }

            await producer.send(TOPICS.WALLET_EVENTS, {
              eventType: 'WALLET_CREDITED',
              walletId: creditResult.wallet.id,
              userId: creditResult.wallet.userId,
              walletAddress: creditResult.wallet.address,
              amountUsdt: event.amountUsdt,
              newBalanceUsdt: Number(creditResult.wallet.balanceUsdt),
              creditType: 'crypto_deposit',
              referenceId: event.paymentId,
              timestamp: new Date().toISOString(),
            } as any, { key: event.userId });
          } catch (err) {
            console.warn(`[${SERVICE_ID}] crypto credit failed:`, (err as any)?.message ?? err);
            throw err;
          }
        }

        if (event.eventType === 'DRIVER_PAYOUT') {
          try {
            const wallet = await walletClient.findByAddress(event.driverWallet);
            const creditResult = await walletClient.credit({
              walletId: wallet.id,
              amountUsdt: event.netPayoutUsdt,
              type: 'DRIVER_PAYOUT' as any,
              referenceId: event.rideId,
              metadata: { platformFeeUsdt: event.platformFeeUsdt },
            });

            if (!creditResult.applied) {
              return;
            }

            await producer.send(TOPICS.WALLET_EVENTS, {
              eventType: 'WALLET_CREDITED',
              walletId: creditResult.wallet.id,
              userId: creditResult.wallet.userId,
              walletAddress: creditResult.wallet.address,
              amountUsdt: event.netPayoutUsdt,
              newBalanceUsdt: Number(creditResult.wallet.balanceUsdt),
              creditType: 'driver_payout',
              referenceId: event.rideId,
              timestamp: new Date().toISOString(),
            } as any, { key: event.driverId });
          } catch (err) {
            console.warn(`[${SERVICE_ID}] payout credit failed:`, (err as any)?.message ?? err);
            throw err;
          }
        }

        if (event.eventType === 'PENALTY_APPLIED') {
          try {
            const wallet = await walletClient.findByAddress(event.riderWallet);
            const debitResult = await walletClient.debit({
              walletId: wallet.id,
              amountUsdt: event.penaltyUsdt,
              type: 'PENALTY' as any,
              referenceId: event.rideId,
            });

            if (!debitResult.applied) {
              return;
            }

            await producer.send(TOPICS.WALLET_EVENTS, {
              eventType: 'WALLET_DEBITED',
              walletId: debitResult.wallet.id,
              userId: debitResult.wallet.userId,
              walletAddress: debitResult.wallet.address,
              amountUsdt: event.penaltyUsdt,
              newBalanceUsdt: Number(debitResult.wallet.balanceUsdt),
              debitType: 'penalty',
              referenceId: event.rideId,
              timestamp: new Date().toISOString(),
            } as any, { key: event.userId });
          } catch (err) {
            console.warn(`[${SERVICE_ID}] penalty debit failed:`, (err as any)?.message ?? err);
            throw err;
          }
        }

        return;
      }

      if (ctx.topic === TOPICS.DEFI_EVENTS) {
        const event = safeParseKafkaEvent(TOPICS.DEFI_EVENTS, value);
        if (!event) return;

        if (event.eventType === 'IDLE_FUNDS_DETECTED' && event.userOptedIn) {
          // Stub: move funds to staked and emit DEFI_STAKED.
          try {
            const wallet = await walletClient.findByAddress(event.walletAddress);
            const stakeAmount = Math.min(Number(wallet.balanceUsdt), event.idleBalanceUsdt);
            if (stakeAmount <= 0) return;

            await walletClient.moveToStaked(wallet.id, stakeAmount);

            await producer.send(TOPICS.DEFI_EVENTS, {
              eventType: 'DEFI_STAKED',
              userId: event.userId,
              walletAddress: wallet.address,
              positionId: randomUUID(),
              amountUsdt: stakeAmount,
              protocol: 'aave',
              tier: event.recommendedTier,
              txHash: 'dev',
              chainId: 8453,
              expectedApyPercent: 4,
              timestamp: new Date().toISOString(),
            } as any, { key: wallet.id });
          } catch (err) {
            console.warn(`[${SERVICE_ID}] stake failed:`, (err as any)?.message ?? err);
          }
        }
      }
    },
  );

  console.log(`[${SERVICE_ID}] consuming`);
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  );
}
