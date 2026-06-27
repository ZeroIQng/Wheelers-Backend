import type { WheelersProducer } from '@wheleers/kafka-client';
import {
  TOPICS,
  type CryptoWalletCreatedEvent,
  type CryptoDepositAddressEvent,
  type CryptoWithdrawCompletedEvent,
  type CryptoBalanceResultEvent,
} from '@wheleers/kafka-schemas';

type PublishOptions = {
  key: string;
};

export interface CryptoWalletEventsProducer {
  publishWalletCreated(
    payload: Omit<CryptoWalletCreatedEvent, 'eventType' | 'timestamp'>,
    options: PublishOptions,
  ): Promise<void>;
  publishDepositAddress(
    payload: Omit<CryptoDepositAddressEvent, 'eventType' | 'timestamp'>,
    options: PublishOptions,
  ): Promise<void>;
  publishWithdrawCompleted(
    payload: Omit<CryptoWithdrawCompletedEvent, 'eventType' | 'timestamp'>,
    options: PublishOptions,
  ): Promise<void>;
  publishBalanceResult(
    payload: Omit<CryptoBalanceResultEvent, 'eventType' | 'timestamp'>,
    options: PublishOptions,
  ): Promise<void>;
}

export function createCryptoWalletEventsProducer(producer: WheelersProducer): CryptoWalletEventsProducer {
  return {
    publishWalletCreated: (payload, options) =>
      publishEvent(producer, {
        eventType: 'CRYPTO_WALLET_CREATED',
        ...payload,
      }, options),

    publishDepositAddress: (payload, options) =>
      publishEvent(producer, {
        eventType: 'CRYPTO_DEPOSIT_ADDRESS',
        ...payload,
      }, options),

    publishWithdrawCompleted: (payload, options) =>
      publishEvent(producer, {
        eventType: 'CRYPTO_WITHDRAW_COMPLETED',
        ...payload,
      }, options),

    publishBalanceResult: (payload, options) =>
      publishEvent(producer, {
        eventType: 'CRYPTO_BALANCE_RESULT',
        ...payload,
      }, options),
  };
}

async function publishEvent(
  producer: WheelersProducer,
  payload: Record<string, unknown>,
  options: PublishOptions,
): Promise<void> {
  await producer.send(TOPICS.CRYPTO_WALLET_EVENTS, {
    ...payload,
    timestamp: new Date().toISOString(),
  }, { key: options.key });
}
