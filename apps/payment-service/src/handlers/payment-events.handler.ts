import type { OnrampSettledEvent } from '@wheleers/kafka-schemas';
import { recordOnrampSettlement } from '../services/settlement.service';

export function createPaymentEventsHandler() {
  return {
    async handleOnrampSettled(event: OnrampSettledEvent): Promise<void> {
      await recordOnrampSettlement(event);
    },
  };
}

export type PaymentEventsHandler = ReturnType<typeof createPaymentEventsHandler>;
