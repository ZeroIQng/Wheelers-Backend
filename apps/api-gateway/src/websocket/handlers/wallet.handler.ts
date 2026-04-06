import { randomUUID } from 'crypto';
import { getNumber, getString } from '../../utils/object';
import type { HandlerResponse } from './types';

export async function handleWalletMessage(
  type: string,
  payload: Record<string, unknown>,
): Promise<HandlerResponse | null> {
  if (type !== 'wallet:deposit_intent') {
    return null;
  }

  const reference = getString(payload, 'reference') ?? randomUUID();
  const amount = getNumber(payload, 'amount') ?? getNumber(payload, 'amountNgn');

  return {
    type: 'wallet:deposit_intent:accepted',
    payload: {
      reference,
      amount,
      currency: getString(payload, 'currency') ?? 'NGN',
    },
  };
}
