import { randomUUID } from 'node:crypto';

import type { MessageContext } from '@wheleers/kafka-client';
import { safeParseKafkaEvent, TOPICS } from '@wheleers/kafka-schemas';

import type { WalletRepository } from '../types';
import type { DefiEventsProducer } from '../producers/defi-events.producer';

export function createDefiEventsConsumer(params: {
  walletRepository: WalletRepository;
  defiEventsProducer: DefiEventsProducer;
  serviceId?: string;
}) {
  const {
    walletRepository,
    defiEventsProducer,
    serviceId = 'wallet-service',
  } = params;

  return {
    async handle(value: unknown, _context: MessageContext): Promise<void> {
      const event = safeParseKafkaEvent(TOPICS.DEFI_EVENTS, value);
      if (!event) return;

      if (event.eventType !== 'IDLE_FUNDS_DETECTED' || !event.userOptedIn) {
        return;
      }

      try {
        const wallet = await walletRepository.findByAddress(event.walletAddress);
        const stakeAmount = Math.min(Number(wallet.balanceUsdt), event.idleBalanceUsdt);
        if (stakeAmount <= 0) {
          return;
        }

        await walletRepository.moveToStaked(wallet.id, stakeAmount);

        await defiEventsProducer.publishStaked({
          userId: event.userId,
          walletAddress: wallet.address,
          positionId: randomUUID(),
          amountUsdt: stakeAmount,
          protocol: 'aave',
          tier: event.recommendedTier,
          txHash: 'dev',
          chainId: 8453,
          expectedApyPercent: 4,
        }, { key: wallet.id });
      } catch (error) {
        console.warn(`[${serviceId}] stake failed:`, getErrorMessage(error));
      }
    },
  };
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
