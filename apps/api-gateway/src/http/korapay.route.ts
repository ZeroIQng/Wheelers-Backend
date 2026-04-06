import { randomUUID } from 'crypto';
import type { IncomingMessage, ServerResponse } from 'http';
import { DepositReceivedEvent } from '@wheleers/kafka-schemas';
import { asIsoTimestamp, isRecord, pickNumber, pickString } from '../utils/object';
import type { GatewayPublisher } from '../websocket/publisher';
import { readJsonBody, sendJson } from './utils';

interface KorapayRouteDeps {
  publisher: GatewayPublisher;
}

export async function handleKorapayWebhookRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: KorapayRouteDeps,
): Promise<void> {
  try {
    const rawBody = await readJsonBody(req);
    if (!isRecord(rawBody)) {
      sendJson(res, 400, { error: 'Body must be a JSON object' });
      return;
    }

    const event = DepositReceivedEvent.parse({
      eventType: 'DEPOSIT_RECEIVED',
      paymentId: pickString(rawBody, ['paymentId', 'data.paymentId']) ?? randomUUID(),
      userId: pickString(rawBody, ['userId', 'data.userId', 'metadata.userId']) ?? '',
      timestamp: asIsoTimestamp(pickString(rawBody, ['timestamp', 'data.timestamp'])),
      amountNgn: pickNumber(rawBody, ['amountNgn', 'amount', 'data.amount']) ?? 0,
      korapayReference:
        pickString(rawBody, ['korapayReference', 'reference', 'data.reference']) ?? '',
      virtualAccountNumber:
        pickString(rawBody, [
          'virtualAccountNumber',
          'virtual_account_number',
          'data.virtualAccountNumber',
          'data.virtual_account_number',
        ]) ?? '',
      userWallet:
        (
          pickString(rawBody, ['userWallet', 'walletAddress', 'metadata.walletAddress']) ??
          ''
        ).toLowerCase(),
    });

    await deps.publisher.publishPaymentEvent(event);

    sendJson(res, 200, {
      received: true,
      paymentId: event.paymentId,
      eventType: event.eventType,
    });

  } catch (error) {
    sendJson(res, 400, {
      error: error instanceof Error ? error.message : 'Invalid Korapay webhook payload',
    });
  }
}
