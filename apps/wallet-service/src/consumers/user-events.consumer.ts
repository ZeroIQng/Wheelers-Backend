import type { MessageContext } from '@wheleers/kafka-client';
import { safeParseKafkaEvent, TOPICS } from '@wheleers/kafka-schemas';

import type { WalletRepository } from '../types';
import { isUniqueConstraintError } from '../utils/prisma';

export function createUserEventsConsumer(params: {
  walletRepository: WalletRepository;
}) {
  const { walletRepository } = params;

  return {
    async handle(value: unknown, _context: MessageContext): Promise<void> {
      const event = safeParseKafkaEvent(TOPICS.USER_EVENTS, value);
      if (!event) return;

      if (
        event.eventType !== 'USER_CREATED' &&
        event.eventType !== 'USER_WALLET_LINKED'
      ) {
        return;
      }

      if (!event.walletAddress) {
        return;
      }

      try {
        await walletRepository.create(event.userId, event.walletAddress);
      } catch (error) {
        if (isUniqueConstraintError(error)) {
          return;
        }

        throw error;
      }
    },
  };
}
