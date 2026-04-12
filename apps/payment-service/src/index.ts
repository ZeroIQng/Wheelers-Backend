import { FEES, validatePaymentEnv, validateSharedEnv } from '@wheleers/config';
import { paymentClient } from '@wheleers/db';
import { createConsumer, createProducer } from '@wheleers/kafka-client';
import { safeParseKafkaEvent, TOPICS } from '@wheleers/kafka-schemas';
import { randomUUID } from 'node:crypto';
import { CoinbaseRatesClient } from './coinbase.client';
import { convertNgnToUsdt } from './conversion';

const SERVICE_ID = 'payment-service';

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

  validateSharedEnv();
  const paymentEnv = validatePaymentEnv();
  const coinbaseRatesClient = new CoinbaseRatesClient(
    paymentEnv.COINBASE_EXCHANGE_RATES_URL,
    paymentEnv.FX_QUOTE_TTL_MS,
  );

  const producer = await createProducer({ serviceId: SERVICE_ID });
  const consumer = await createConsumer({ groupId: SERVICE_ID });

  await consumer.subscribe(
    [TOPICS.PAYMENT_EVENTS, TOPICS.RIDE_EVENTS],
    async (value, ctx) => {
      if (ctx.topic === TOPICS.PAYMENT_EVENTS) {
        const event = safeParseKafkaEvent(TOPICS.PAYMENT_EVENTS, value);
        if (!event) return;

        if (event.eventType === 'DEPOSIT_RECEIVED') {
          try {
            await paymentClient.recordDepositReceived({
              paymentId: event.paymentId,
              userId: event.userId,
              provider: event.paymentProvider,
              providerReference: event.providerReference,
              userWallet: event.userWallet,
              amountNgn: event.amountNgn,
              metadata: {
                paymentChannel: event.paymentChannel,
                customerEmail: event.customerEmail,
                virtualAccountNumber: event.virtualAccountNumber,
              },
            });

            const claimed = await paymentClient.claimConversion(event.providerReference);
            if (!claimed) {
              return;
            }

            const exchangeRate = await coinbaseRatesClient.getNgnPerUsdRate();
            const conversion = convertNgnToUsdt(
              event.amountNgn,
              exchangeRate,
            );
            const conversionJobId = `paystack-${event.providerReference}`;
            const conversionReference = `settlement-${event.providerReference}`;

            await producer.send(TOPICS.PAYMENT_EVENTS, {
              eventType: 'NGN_CONVERTING',
              paymentId: event.paymentId,
              userId: event.userId,
              paymentProvider: event.paymentProvider,
              amountNgn: event.amountNgn,
              estimatedUsdt: conversion.amountUsdt,
              providerReference: event.providerReference,
              conversionJobId,
              timestamp: new Date().toISOString(),
            } as any, { key: event.userId });

            await producer.send(TOPICS.PAYMENT_EVENTS, {
              eventType: 'NGN_CONVERTED',
              paymentId: event.paymentId,
              userId: event.userId,
              paymentProvider: event.paymentProvider,
              amountNgn: event.amountNgn,
              amountUsdt: conversion.amountUsdt,
              exchangeRate: conversion.exchangeRate,
              providerReference: event.providerReference,
              userWallet: event.userWallet,
              conversionReference,
              timestamp: new Date().toISOString(),
            } as any, { key: event.userId });
            
            await paymentClient.markConverted({
              providerReference: event.providerReference,
              amountUsdt: conversion.amountUsdt,
              exchangeRate: conversion.exchangeRate,
              metadata: {
                paymentChannel: event.paymentChannel,
                customerEmail: event.customerEmail,
                virtualAccountNumber: event.virtualAccountNumber,
                fxProvider: paymentEnv.FX_PROVIDER,
                ngnPerUsdRate: conversion.exchangeRate,
                conversionReference,
              },
            });
          } catch (error) {
            await paymentClient.releaseConversionClaim(event.providerReference).catch(() => {});
            throw error;
          }
        }

        return;
      }

      if (ctx.topic === TOPICS.RIDE_EVENTS) {
        const event = safeParseKafkaEvent(TOPICS.RIDE_EVENTS, value);
        if (!event) return;

        if (event.eventType === 'RIDE_COMPLETED') {
          const profit = Math.max(0, event.fareUsdt);
          const fee = profit > 0 ? round2(profit * FEES.PLATFORM_FEE_PERCENT) : 0;
          const net = round2(profit - fee);

          await producer.send(TOPICS.PAYMENT_EVENTS, {
            eventType: 'DRIVER_PAYOUT',
            paymentId: randomUUID(),
            userId: event.riderId,
            rideId: event.rideId,
            driverId: event.driverId,
            driverWallet: event.driverWallet,
            grossFareUsdt: profit,
            driverCostsUsdt: 0,
            driverProfitUsdt: profit,
            platformFeeUsdt: fee,
            netPayoutUsdt: net,
            feeApplied: fee > 0,
            timestamp: new Date().toISOString(),
          } as any, { key: event.rideId });
        }

        if (event.eventType === 'RIDE_CANCELLED') {
          const penalty = cancelPenalty(event.cancelStage);
          if (penalty <= 0) return;

          await producer.send(TOPICS.PAYMENT_EVENTS, {
            eventType: 'PENALTY_APPLIED',
            paymentId: randomUUID(),
            userId: event.riderId,
            rideId: event.rideId,
            riderWallet: event.riderWallet,
            penaltyUsdt: penalty,
            reason: cancelReason(event.cancelStage),
            timestamp: new Date().toISOString(),
          } as any, { key: event.rideId });
        }
      }
    },
  );

  console.log(`[${SERVICE_ID}] consuming`);
}

function cancelPenalty(stage: string): number {
  switch (stage) {
    case 'after_match':
      return FEES.CANCEL_PENALTY_AFTER_MATCH_USDT;
    case 'driver_en_route':
      return FEES.CANCEL_PENALTY_EN_ROUTE_USDT;
    case 'active_trip':
      return FEES.CANCEL_PENALTY_ACTIVE_TRIP_USDT;
    case 'before_match':
    default:
      return 0;
  }
}

function cancelReason(stage: string): string {
  switch (stage) {
    case 'after_match':
      return 'rider_cancel_after_match';
    case 'driver_en_route':
      return 'rider_cancel_en_route';
    case 'active_trip':
      return 'rider_cancel_active_trip';
    default:
      return 'rider_cancel_after_match';
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
