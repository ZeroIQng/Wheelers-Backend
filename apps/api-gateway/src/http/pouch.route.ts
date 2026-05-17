import type { IncomingMessage, ServerResponse } from 'http';
import { paymentClient, userClient } from '@wheleers/db';
import type { PaymentSessionType } from '@prisma/client';
import { verifyPrivyAccessToken } from '../auth/privy';
import { isRecord, pickNumber, pickString } from '../utils/object';
import type { GatewayPublisher } from '../websocket/publisher';
import {
  buildPaymentIntentUpsertFromEvent,
  buildPouchMetadata,
  normalizePouchTransactionCreated,
  normalizePouchTransactionStatus,
} from './pouch.helpers';
import {
  PouchApiError,
  PouchClient,
  type PouchOfframpPayload,
  type PouchOnrampPayload,
} from './pouch.client';
import { readJsonBody, sendJson } from './utils';

interface PouchRouteDeps {
  privyAppId: string;
  privyVerificationKey: string;
  pouchClient: PouchClient;
  publisher: GatewayPublisher;
  defaults: {
    providerId: string;
    countryCode: string;
    currency: string;
    cryptoCurrency: string;
    cryptoNetwork: string;
    chain?: string;
    masterWalletAddress: string;
  };
}

interface PouchHealthRouteDeps {
  pouchClient: PouchClient;
}

export async function handlePouchHealthRoute(
  _req: IncomingMessage,
  res: ServerResponse,
  deps: PouchHealthRouteDeps,
): Promise<void> {
  try {
    const health = await deps.pouchClient.health();
    sendJson(res, 200, { provider: 'pouch', health });
  } catch (error) {
    sendPouchError(res, error, 'Failed to load Pouch health');
  }
}

export async function handlePouchOnrampRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: PouchRouteDeps,
): Promise<void> {
  try {
    const rawBody = await readJsonBody(req);
    if (!isRecord(rawBody)) {
      sendJson(res, 400, { error: 'Body must be a JSON object' });
      return;
    }

    const auth = await authenticateHttpUser(req, deps.privyAppId, deps.privyVerificationKey);
    const paymentWallet = auth.user.walletAddress?.toLowerCase();

    if (!paymentWallet) {
      sendJson(res, 400, { error: 'Authenticated user does not have a wallet address' });
      return;
    }

    const customerEmail = resolveCustomerEmail(rawBody, auth.verifiedToken);
    const walletTag = pickString(rawBody, ['walletTag']);
    const payload = buildOnrampPayload(rawBody, deps.defaults);
    const response = await deps.pouchClient.createSharedKycOnramp(payload);
    const createdEvent = normalizePouchTransactionCreated({
      type: 'ONRAMP',
      payload: response,
      metadata: buildPouchMetadata({
        userId: auth.user.id,
        walletAddress: paymentWallet,
      }),
      customerEmail,
      chain: deps.defaults.chain,
      walletTag,
    });

    if (!createdEvent) {
      throw new Error('Pouch onramp response could not be normalized');
    }

    await paymentClient.upsertPaymentIntent(
      buildPaymentIntentUpsertFromEvent(createdEvent, response),
    );
    await deps.publisher.publishPaymentEvent(createdEvent);

    sendJson(res, 200, {
      provider: 'pouch',
      type: 'ONRAMP',
      providerRef: response.providerRef,
      destinationWalletAddress: payload.walletAddress,
      paymentInstruction: response.paymentInstruction,
      walletCreditable:
        createdEvent.cryptoCurrency === 'USDT' || createdEvent.cryptoCurrency === 'USDC',
    });
  } catch (error) {
    sendPouchError(res, error, 'Failed to create Pouch onramp transaction');
  }
}

export async function handlePouchOfframpRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: PouchRouteDeps,
): Promise<void> {
  try {
    const rawBody = await readJsonBody(req);
    if (!isRecord(rawBody)) {
      sendJson(res, 400, { error: 'Body must be a JSON object' });
      return;
    }

    const auth = await authenticateHttpUser(req, deps.privyAppId, deps.privyVerificationKey);
    const paymentWallet = auth.user.walletAddress?.toLowerCase();

    if (!paymentWallet) {
      sendJson(res, 400, { error: 'Authenticated user does not have a wallet address' });
      return;
    }

    const customerEmail = resolveCustomerEmail(rawBody, auth.verifiedToken);
    const payload = buildOfframpPayload(rawBody, deps.defaults);
    const response = await deps.pouchClient.createSharedKycOfframp(payload);
    const createdEvent = normalizePouchTransactionCreated({
      type: 'OFFRAMP',
      payload: response,
      metadata: buildPouchMetadata({
        userId: auth.user.id,
        walletAddress: paymentWallet,
      }),
      customerEmail,
      chain: deps.defaults.chain,
    });

    if (!createdEvent) {
      throw new Error('Pouch offramp response could not be normalized');
    }

    await paymentClient.upsertPaymentIntent(
      buildPaymentIntentUpsertFromEvent(createdEvent, response),
    );
    await deps.publisher.publishPaymentEvent(createdEvent);

    sendJson(res, 200, {
      provider: 'pouch',
      type: 'OFFRAMP',
      providerRef: response.providerRef,
      cryptoInstruction: response.cryptoInstruction,
    });
  } catch (error) {
    sendPouchError(res, error, 'Failed to create Pouch offramp transaction');
  }
}

export async function handlePouchStatusRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: PouchRouteDeps,
  providerRef: string,
  requestedType?: PaymentSessionType,
): Promise<void> {
  try {
    const auth = await authenticateHttpUser(req, deps.privyAppId, deps.privyVerificationKey);
    const intent = await paymentClient.findPaymentIntentByProviderReference(providerRef);

    if (!intent || intent.userId !== auth.user.id) {
      sendJson(res, 404, { error: 'Pouch transaction not found' });
      return;
    }

    const statusResponse = await deps.pouchClient.getRampStatus(
      providerRef,
      requestedType ?? intent.sessionType,
    );
    const syncedEvent = normalizePouchTransactionStatus({
      payload: statusResponse,
      intent,
    });

    if (syncedEvent) {
      await paymentClient.upsertPaymentIntent(
        buildPaymentIntentUpsertFromEvent(syncedEvent, statusResponse),
      );
      await deps.publisher.publishPaymentEvent(syncedEvent);
    }

    sendJson(res, 200, {
      provider: 'pouch',
      status: statusResponse,
      sessionSynced: Boolean(syncedEvent),
    });
  } catch (error) {
    sendPouchError(res, error, 'Failed to load Pouch transaction status');
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

function buildOnrampPayload(
  body: Record<string, unknown>,
  defaults: PouchRouteDeps['defaults'],
): PouchOnrampPayload {
  const amount = pickNumber(body, ['amount', 'amountLocal', 'localAmount', 'ngnAmount']);
  if (!amount || amount <= 0) {
    throw new Error('amount must be a positive number');
  }

  const userKyc = readUserKyc(body['userKyc']);

  return {
    amount: roundAmount(amount),
    cryptoCurrency:
      pickString(body, ['cryptoCurrency'])?.toUpperCase() ?? defaults.cryptoCurrency,
    cryptoNetwork:
      pickString(body, ['cryptoNetwork'])?.toUpperCase() ?? defaults.cryptoNetwork,
    walletAddress: defaults.masterWalletAddress,
    walletTag: pickString(body, ['walletTag']) ?? undefined,
    countryCode: pickString(body, ['countryCode'])?.toUpperCase() ?? defaults.countryCode,
    currency: pickString(body, ['currency'])?.toUpperCase() ?? defaults.currency,
    providerId: pickString(body, ['providerId']) ?? defaults.providerId,
    userKyc: userKyc ?? undefined,
  };
}

function buildOfframpPayload(
  body: Record<string, unknown>,
  defaults: PouchRouteDeps['defaults'],
): PouchOfframpPayload {
  const cryptoAmount = pickNumber(body, ['cryptoAmount', 'amount']);
  if (!cryptoAmount || cryptoAmount <= 0) {
    throw new Error('cryptoAmount must be a positive number');
  }

  const bankAccount = isRecord(body['bankAccount']) ? body['bankAccount'] : null;
  if (!bankAccount) {
    throw new Error('bankAccount is required');
  }

  const accountNumber = pickString(bankAccount, ['accountNumber']);
  const accountName = pickString(bankAccount, ['accountName']);
  const networkId = pickString(bankAccount, ['networkId']);

  if (!accountNumber || !accountName || !networkId) {
    throw new Error('bankAccount.accountNumber, accountName, and networkId are required');
  }

  const userKyc = readUserKyc(body['userKyc']);

  return {
    cryptoAmount: roundAmount(cryptoAmount),
    cryptoCurrency:
      pickString(body, ['cryptoCurrency'])?.toUpperCase() ?? defaults.cryptoCurrency,
    cryptoNetwork:
      pickString(body, ['cryptoNetwork'])?.toUpperCase() ?? defaults.cryptoNetwork,
    countryCode: pickString(body, ['countryCode'])?.toUpperCase() ?? defaults.countryCode,
    currency: pickString(body, ['currency'])?.toUpperCase() ?? defaults.currency,
    providerId: pickString(body, ['providerId']) ?? defaults.providerId,
    bankAccount: {
      accountNumber,
      accountName,
      networkId,
    },
    userKyc: userKyc ?? undefined,
  };
}

function readUserKyc(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function resolveCustomerEmail(
  body: Record<string, unknown>,
  verifiedToken: ReturnType<typeof verifyPrivyAccessToken>,
): string | undefined {
  return (
    pickString(body, ['email']) ??
    (typeof verifiedToken.claims['email'] === 'string'
      ? verifiedToken.claims['email']
      : undefined)
  );
}

function roundAmount(value: number): number {
  return Math.round(value * 100) / 100;
}

function extractBearerToken(value: string | undefined): string | undefined {
  if (!value) return undefined;

  const [scheme, token] = value.split(' ');
  if (!scheme || !token || scheme.toLowerCase() !== 'bearer') {
    return undefined;
  }

  return token;
}

function sendPouchError(
  res: ServerResponse,
  error: unknown,
  fallbackMessage: string,
): void {
  if (error instanceof PouchApiError) {
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
