import { randomUUID } from 'crypto';
import type { IncomingMessage, ServerResponse } from 'http';
import { NgnConvertedEvent } from '@wheleers/kafka-schemas';
import { asIsoTimestamp, isRecord, pickNumber, pickString } from '../utils/object';
import type { GatewayPublisher } from '../websocket/publisher';
import { readJsonBody, sendJson } from './utils';

interface YellowCardRouteDeps {
  publisher: GatewayPublisher;
}

export async function handleYellowCardWebhookRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: YellowCardRouteDeps,
): Promise<void> {
  try {
    const rawBody = await readJsonBody(req);
    if (!isRecord(rawBody)) {
      sendJson(res, 400, { error: 'Body must be a JSON object' });
      return;
    }

    const amountNgn = pickNumber(rawBody, ['amountNgn', 'amount', 'data.amount']) ?? 0;
    const amountUsdt = pickNumber(rawBody, ['amountUsdt', 'amount_usdt', 'data.amountUsdt']) ?? 0;

    const event = NgnConvertedEvent.parse({
      eventType: 'NGN_CONVERTED',
      paymentId: pickString(rawBody, ['paymentId', 'data.paymentId']) ?? randomUUID(),
      userId: pickString(rawBody, ['userId', 'data.userId', 'metadata.userId']) ?? '',
      timestamp: asIsoTimestamp(pickString(rawBody, ['timestamp', 'data.timestamp'])),
      amountNgn,
      amountUsdt,
      exchangeRate: pickNumber(rawBody, ['exchangeRate', 'data.exchangeRate']) ?? 0,
      userWallet:
        (
          pickString(rawBody, ['userWallet', 'walletAddress', 'metadata.walletAddress']) ??
          ''
        ).toLowerCase(),
      yellowcardReference:
        pickString(rawBody, ['yellowcardReference', 'reference', 'data.reference']) ?? '',
    });

    await deps.publisher.publishPaymentEvent(event);

    sendJson(res, 200, {
      received: true,
      paymentId: event.paymentId,
      eventType: event.eventType,
    });

  } catch (error) {
    sendJson(res, 400, {
      error: error instanceof Error ? error.message : 'Invalid YellowCard webhook payload',
    });
  }
}
