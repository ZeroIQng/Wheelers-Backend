import type { IncomingMessage, ServerResponse } from 'http';
import { userClient } from '@wheleers/db';
import { verifyPrivyAccessToken } from '../auth/privy';
import { getString, isRecord, pickNumber, pickString } from '../utils/object';
import type { GatewayPublisher } from '../websocket/publisher';
import {
  buildPaystackMetadata,
  buildPaystackReference,
  normalizePaystackChargeSuccess,
  readPaystackMetadata,
  verifyPaystackSignature,
} from './paystack.helpers';
import {
  PaystackApiError,
  PaystackClient,
  type PaystackVerifyTransactionResponse,
} from './paystack.client';
import { parseJsonBuffer, readJsonBody, readRawBody, sendJson } from './utils';

interface PaystackInitializeRouteDeps {
  privyAppId: string;
  privyVerificationKey: string;
  paystackClient: PaystackClient;
  paystackPublicKey: string;
  defaultCallbackUrl?: string;
  defaultChannels: string[];
}

interface PaystackVerifyRouteDeps {
  privyAppId: string;
  privyVerificationKey: string;
  paystackClient: PaystackClient;
  publisher: GatewayPublisher;
}

interface PaystackWebhookRouteDeps {
  publisher: GatewayPublisher;
  webhookSecret: string;
}

export async function handlePaystackInitializeRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: PaystackInitializeRouteDeps,
): Promise<void> {
  try {
    const rawBody = await readJsonBody(req);
    if (!isRecord(rawBody)) {
      sendJson(res, 400, { error: 'Body must be a JSON object' });
      return;
    }

    const auth = await authenticateHttpUser(req, deps.privyAppId, deps.privyVerificationKey);
    const amountNgn = pickNumber(rawBody, ['amountNgn', 'amount']);

    if (!amountNgn || amountNgn <= 0) {
      sendJson(res, 400, { error: 'amountNgn must be a positive number' });
      return;
    }

    const email =
      pickString(rawBody, ['email']) ??
      (typeof auth.verifiedToken.claims['email'] === 'string'
        ? auth.verifiedToken.claims['email']
        : undefined);

    if (!email) {
      sendJson(res, 400, {
        error: 'email is required to initialize a Paystack transaction',
      });
      return;
    }

    const reference = buildPaystackReference(auth.user.id);
    const callbackUrl = pickString(rawBody, ['callbackUrl', 'callback_url']) ?? deps.defaultCallbackUrl;
    const channels = getChannels(rawBody, deps.defaultChannels);
    const amountKobo = Math.round(amountNgn * 100);

    const initialized = await deps.paystackClient.initializeTransaction({
      email,
      amountKobo,
      reference,
      callbackUrl,
      channels,
      metadata: {
        ...buildPaystackMetadata({
          userId: auth.user.id,
          walletAddress: auth.user.walletAddress,
        }),
        amountNgn,
      },
    });

    sendJson(res, 200, {
      provider: 'paystack',
      reference: initialized.reference,
      amountNgn,
      amountKobo,
      authorizationUrl: initialized.authorization_url,
      accessCode: initialized.access_code,
      publicKey: deps.paystackPublicKey,
      callbackUrl: callbackUrl ?? null,
      channels,
    });
  } catch (error) {
    sendPaystackError(res, error, 'Failed to initialize Paystack transaction');
  }
}

export async function handlePaystackVerifyRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: PaystackVerifyRouteDeps,
): Promise<void> {
  try {
    const auth = await authenticateHttpUser(req, deps.privyAppId, deps.privyVerificationKey);
    const url = new URL(req.url ?? '/', 'http://localhost');
    const reference = url.searchParams.get('reference') ?? '';

    if (!reference) {
      sendJson(res, 400, { error: 'reference query parameter is required' });
      return;
    }

    const verified = await deps.paystackClient.verifyTransaction(reference);
    const metadata = readPaystackMetadata(verified.metadata);

    if (metadata && metadata.userId !== auth.user.id) {
      sendJson(res, 403, { error: 'This payment reference does not belong to the authenticated user' });
      return;
    }

    const normalized = normalizePaystackChargeSuccess({
      ...verified,
      metadata,
    });

    if (normalized) {
      await deps.publisher.publishPaymentEvent(normalized);
    }

    sendJson(res, 200, buildVerifyResponse(reference, verified, metadata, normalized !== null));
  } catch (error) {
    sendPaystackError(res, error, 'Failed to verify Paystack transaction');
  }
}

export async function handlePaystackWebhookRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: PaystackWebhookRouteDeps,
): Promise<void> {
  try {
    const rawBody = await readRawBody(req);
    const signature =
      typeof req.headers['x-paystack-signature'] === 'string'
        ? req.headers['x-paystack-signature']
        : undefined;

    if (!verifyPaystackSignature(rawBody, signature, deps.webhookSecret)) {
      sendJson(res, 401, { error: 'Invalid Paystack signature' });
      return;
    }

    const rawPayload = parseJsonBuffer(rawBody);
    if (!isRecord(rawPayload)) {
      sendJson(res, 400, { error: 'Webhook body must be a JSON object' });
      return;
    }

    if (getString(rawPayload, 'event') !== 'charge.success') {
      sendJson(res, 200, { received: true, ignored: true });
      return;
    }

    const event = normalizePaystackChargeSuccess(rawPayload['data']);
    if (!event) {
      sendJson(res, 200, {
        received: true,
        ignored: true,
        reason: 'charge.success payload is missing Wheelers metadata',
      });
      return;
    }

    await deps.publisher.publishPaymentEvent(event);

    sendJson(res, 200, {
      received: true,
      eventType: event.eventType,
      paymentId: event.paymentId,
      providerReference: event.providerReference,
    });
  } catch (error) {
    sendJson(res, 400, {
      error: error instanceof Error ? error.message : 'Invalid Paystack webhook payload',
    });
  }
}

async function authenticateHttpUser(
  req: IncomingMessage,
  appId: string,
  verificationKey: string,
): Promise<{
  user: NonNullable<Awaited<ReturnType<typeof userClient.findByPrivyDid>>>;
  verifiedToken: ReturnType<typeof verifyPrivyAccessToken>;
}> {
  const authorization =
    typeof req.headers.authorization === 'string' ? req.headers.authorization : undefined;
  const token = extractBearerToken(authorization);

  if (!token) {
    throw new Error('Authorization bearer token is required');
  }

  const verifiedToken = verifyPrivyAccessToken({
    accessToken: token,
    appId,
    verificationKey,
  });

  const user = await userClient.findByPrivyDid(verifiedToken.privyDid);
  if (!user) {
    throw new Error('User not registered. Call POST /auth/privy first.');
  }

  return { user, verifiedToken };
}

function extractBearerToken(value: string | undefined): string | undefined {
  if (!value) return undefined;

  const [scheme, token] = value.split(' ');
  if (!scheme || !token || scheme.toLowerCase() !== 'bearer') {
    return undefined;
  }

  return token;
}

function getChannels(body: Record<string, unknown>, fallback: string[]): string[] {
  const explicit = body['channels'];
  if (Array.isArray(explicit)) {
    return explicit.filter((value): value is string => typeof value === 'string' && value.length > 0);
  }

  const single = pickString(body, ['channel']);
  if (single) {
    return [single];
  }

  return fallback;
}

function buildVerifyResponse(
  reference: string,
  verified: PaystackVerifyTransactionResponse,
  metadata: ReturnType<typeof readPaystackMetadata>,
  reconciled: boolean,
): Record<string, unknown> {
  return {
    provider: 'paystack',
    reference,
    status: verified.status ?? 'unknown',
    paid: verified.status === 'success',
    amountNgn: typeof verified.amount === 'number' ? verified.amount / 100 : null,
    currency: verified.currency ?? 'NGN',
    channel: verified.channel ?? null,
    customerEmail: verified.customer?.email ?? null,
    paidAt: verified.paid_at ?? null,
    gatewayResponse: verified.gateway_response ?? verified.message ?? null,
    userWallet: metadata?.walletAddress ?? null,
    readyForWalletFunding: reconciled,
    reconciliationTriggered: reconciled,
  };
}

function sendPaystackError(
  res: ServerResponse,
  error: unknown,
  fallbackMessage: string,
): void {
  if (error instanceof PaystackApiError) {
    sendJson(res, error.statusCode, {
      error: fallbackMessage,
      details: error.responseBody,
    });
    return;
  }

  sendJson(res, 400, {
    error: error instanceof Error ? error.message : fallbackMessage,
  });
}
