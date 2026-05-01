import type { WheelersProducer } from '@wheleers/kafka-client';
import {
  TOPICS,
  type WalletCreditedEvent,
  type WalletDebitedEvent,
  type WalletHoldAdjustedEvent,
  type WalletLockedEvent,
  type WalletUnlockedEvent,
} from '@wheleers/kafka-schemas';

type PublishOptions = {
  key: string;
};

export interface WalletEventsProducer {
  publishCredited(
    payload: Omit<WalletCreditedEvent, 'eventType' | 'timestamp'>,
    options: PublishOptions,
  ): Promise<void>;
  publishDebited(
    payload: Omit<WalletDebitedEvent, 'eventType' | 'timestamp'>,
    options: PublishOptions,
  ): Promise<void>;
  publishLocked(
    payload: Omit<WalletLockedEvent, 'eventType' | 'timestamp'>,
    options: PublishOptions,
  ): Promise<void>;
  publishUnlocked(
    payload: Omit<WalletUnlockedEvent, 'eventType' | 'timestamp'>,
    options: PublishOptions,
  ): Promise<void>;
  publishHoldAdjusted(
    payload: Omit<WalletHoldAdjustedEvent, 'eventType' | 'timestamp'>,
    options: PublishOptions,
  ): Promise<void>;
}

export function createWalletEventsProducer(producer: WheelersProducer): WalletEventsProducer {
  return {
    publishCredited: (payload, options) =>
      publishEvent(producer, {
        eventType: 'WALLET_CREDITED',
        ...payload,
      }, options),

    publishDebited: (payload, options) =>
      publishEvent(producer, {
        eventType: 'WALLET_DEBITED',
        ...payload,
      }, options),

    publishLocked: (payload, options) =>
      publishEvent(producer, {
        eventType: 'WALLET_LOCKED',
        ...payload,
      }, options),

    publishUnlocked: (payload, options) =>
      publishEvent(producer, {
        eventType: 'WALLET_UNLOCKED',
        ...payload,
      }, options),

    publishHoldAdjusted: (payload, options) =>
      publishEvent(producer, {
        eventType: 'WALLET_HOLD_ADJUSTED',
        ...payload,
      }, options),
  };
}

async function publishEvent(
  producer: WheelersProducer,
  payload: Record<string, unknown>,
  options: PublishOptions,
): Promise<void> {
  await producer.send(TOPICS.WALLET_EVENTS, {
    ...payload,
    timestamp: new Date().toISOString(),
  }, { key: options.key });
}
