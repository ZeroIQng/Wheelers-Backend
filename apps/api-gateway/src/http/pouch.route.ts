import {
  createHmac,
  randomInt,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'http';
import { paymentClient, userClient, withdrawalClient } from '@wheleers/db';
import type { PaymentSessionType } from '@prisma/client';
import type { InAppSendEvent } from '@wheleers/kafka-schemas';
import type { RidePricingDisplayProvider } from '../pricing/display';
import { verifyPrivyAccessToken } from '../auth/privy';
import { isRecord, pickNumber, pickString } from '../utils/object';
import type { GatewayPublisher } from '../websocket/publisher';
import {
  buildPaymentIntentUpsertFromEvent,
  buildPouchMetadata,
  deriveLifecycleStatus,
  normalizePouchTransactionCreated,
  normalizePouchTransactionStatus,
} from './pouch.helpers';
import {
  PouchApiError,
  PouchClient,
  type PouchOfframpPayload,
  type PouchOnrampPayload,
} from './pouch.client';
import { parseJsonBuffer, readJsonBody, readRawBody, sendJson } from './utils';

interface PouchRouteDeps {
  privyAppId: string;
  privyVerificationKey: string;
  pouchClient: PouchClient;
  publisher: GatewayPublisher;
  ridePricingDisplayProvider: RidePricingDisplayProvider;
  defaults: {
    providerId: string;
    countryCode: string;
    currency: string;
    cryptoCurrency: string;
    cryptoNetwork: string;
    chain?: string;
    masterWalletAddress: string;
    walletTag?: string;
    testEmail?: string;
    userKycDefaults?: Record<string, string>;
  };
}

interface PouchHealthRouteDeps {
  pouchClient: PouchClient;
}

interface PouchWebhookRouteDeps {
  publisher: GatewayPublisher;
  webhookSecret?: string;
}

export async function handlePouchHealthRoute(
  _req: IncomingMessage,
  res: ServerResponse,
  deps: PouchHealthRouteDeps,
): Promise<void> {
  try {
    console.log('[api-gateway][pouch] health check requested');
    const health = await deps.pouchClient.health();
    sendJson(res, 200, { provider: 'pouch', health });
  } catch (error) {
    sendPouchError(res, error, 'Failed to load Pouch health');
  }
}

export async function handlePouchWebhookRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: PouchWebhookRouteDeps,
): Promise<void> {
  try {
    if (!deps.webhookSecret) {
      console.error('[api-gateway][pouch-webhook] secret not configured');
      sendJson(res, 503, { error: 'POUCH_WEBHOOK_SECRET is not configured' });
      return;
    }

    const rawBody = await readRawBody(req);
    const signature = getWebhookSignature(req);

    if (!signature) {
      console.warn('[api-gateway][pouch-webhook] missing signature header');
      sendJson(res, 401, { error: 'Missing webhook signature' });
      return;
    }

    if (!isValidWebhookSignature(rawBody, signature, deps.webhookSecret)) {
      console.warn('[api-gateway][pouch-webhook] invalid signature');
      sendJson(res, 401, { error: 'Invalid webhook signature' });
      return;
    }

    const parsedBody = parseJsonBuffer(rawBody);
    if (!isRecord(parsedBody)) {
      sendJson(res, 400, { error: 'Webhook body must be a JSON object' });
      return;
    }

    const eventName = extractWebhookEventName(parsedBody);
    const payload = unwrapWebhookPayload(parsedBody);
    const providerReference = pickString(payload, [
      'providerRef',
      'reference',
      'details.reference',
      'paymentInstruction.reference',
      'cryptoInstruction.reference',
      'transaction.reference',
      'data.providerRef',
      'data.reference',
    ]);

    console.log('[api-gateway][pouch-webhook] received', {
      eventName: eventName ?? null,
      providerReference: providerReference ?? null,
    });

    if (!eventName) {
      sendJson(res, 202, {
        received: true,
        processed: false,
        ignored: 'Missing event name',
      });
      return;
    }

    if (!providerReference) {
      sendJson(res, 202, {
        received: true,
        processed: false,
        ignored: 'Missing provider reference',
        eventName,
      });
      return;
    }

    const intent = await paymentClient.findPaymentIntentByProviderReference(providerReference);
    if (!intent) {
      console.warn('[api-gateway][pouch-webhook] payment intent not found', {
        eventName,
        providerReference,
      });
      sendJson(res, 202, {
        received: true,
        processed: false,
        ignored: 'Payment intent not found',
        eventName,
        providerReference,
      });
      return;
    }

    const enrichedPayload = enrichWebhookPayloadForIntent(payload, eventName, intent.sessionType);

    let paymentEventPublished = false;
    let notificationPublished = false;

    if (shouldSyncPaymentIntentFromWebhook(eventName)) {
      const syncedEvent = normalizePouchTransactionStatus({
        payload: enrichedPayload,
        intent,
      });

      if (syncedEvent) {
        const isDuplicate =
          intent.providerStatus.trim().toUpperCase() === syncedEvent.status.trim().toUpperCase() &&
          (intent.settlementReference ?? null) === (syncedEvent.settlementReference ?? null);

        if (!isDuplicate) {
          await paymentClient.upsertPaymentIntent(
            buildPaymentIntentUpsertFromEvent(syncedEvent, payload),
          );
          if (intent.sessionType === 'OFFRAMP') {
            await syncWithdrawalLifecycleFromStatus(providerReference, enrichedPayload);
          }
          await deps.publisher.publishPaymentEvent(syncedEvent);
          paymentEventPublished = true;
        }
      }
    }

    const notification = buildWebhookNotification(intent, eventName, providerReference);
    if (notification) {
      await deps.publisher.publishNotificationEvent(notification);
      notificationPublished = true;
    }

    sendJson(res, 200, {
      received: true,
      processed: paymentEventPublished || notificationPublished,
      eventName,
      providerReference,
      paymentEventPublished,
      notificationPublished,
    });
  } catch (error) {
    console.error('[api-gateway][pouch-webhook] route error', {
      message: error instanceof Error ? error.message : String(error),
    });
    sendJson(res, 500, { error: 'Failed to process Pouch webhook' });
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

    const payload = await buildOnrampPayload(
      rawBody,
      deps.defaults,
      deps.ridePricingDisplayProvider,
    );
    const customerEmail = resolveCustomerEmail(rawBody, auth.verifiedToken, deps.defaults.testEmail);
    const walletTag = payload.walletTag;

    console.log('[api-gateway][pouch] creating onramp', {
      userId: auth.user.id,
      userWallet: paymentWallet,
      email: customerEmail,
      summary: summarizeOnrampPayload(payload, rawBody),
    });

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
      console.error('[api-gateway][pouch] onramp response normalization failed', {
        userId: auth.user.id,
        response: summarizeCreateResponse(response),
      });
      throw new Error('Pouch onramp response could not be normalized');
    }

    await paymentClient.upsertPaymentIntent(
      buildPaymentIntentUpsertFromEvent(createdEvent, response),
    );
    await deps.publisher.publishPaymentEvent(createdEvent);

    console.log('[api-gateway][pouch] onramp created', {
      userId: auth.user.id,
      providerRef: createdEvent.providerReference,
      paymentId: createdEvent.paymentId,
      amountLocal: createdEvent.amountLocal,
      amountUsd: createdEvent.amountUsd,
      cryptoCurrency: createdEvent.cryptoCurrency,
      cryptoNetwork: createdEvent.cryptoNetwork,
    });

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

    const payload = buildOfframpPayload(rawBody, deps.defaults);
    const customerEmail = resolveCustomerEmail(rawBody, auth.verifiedToken, deps.defaults.testEmail);

    console.log('[api-gateway][pouch] creating offramp', {
      userId: auth.user.id,
      userWallet: paymentWallet,
      email: customerEmail,
      summary: summarizeOfframpPayload(payload),
    });

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
      console.error('[api-gateway][pouch] offramp response normalization failed', {
        userId: auth.user.id,
        response: summarizeCreateResponse(response),
      });
      throw new Error('Pouch offramp response could not be normalized');
    }

    await paymentClient.upsertPaymentIntent(
      buildPaymentIntentUpsertFromEvent(createdEvent, response),
    );
    await deps.publisher.publishPaymentEvent(createdEvent);

    console.log('[api-gateway][pouch] offramp created', {
      userId: auth.user.id,
      providerRef: createdEvent.providerReference,
      paymentId: createdEvent.paymentId,
      amountLocal: createdEvent.amountLocal,
      amountUsd: createdEvent.amountUsd,
      cryptoCurrency: createdEvent.cryptoCurrency,
      cryptoNetwork: createdEvent.cryptoNetwork,
    });

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
    console.log('[api-gateway][pouch] status requested', {
      userId: auth.user.id,
      providerRef,
      requestedType: requestedType ?? null,
    });

    const intent = await paymentClient.findPaymentIntentByProviderReference(providerRef);

    if (!intent || intent.userId !== auth.user.id) {
      console.warn('[api-gateway][pouch] status lookup miss', {
        providerRef,
        requestedByUserId: auth.user.id,
        intentFound: Boolean(intent),
        ownerUserId: intent?.userId ?? null,
      });
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

    console.log('[api-gateway][pouch] status received', {
      userId: auth.user.id,
      providerRef,
      sessionType: intent.sessionType,
      providerStatus: summarizeStatusResponse(statusResponse),
      normalized: Boolean(syncedEvent),
    });

    if (syncedEvent) {
      await paymentClient.upsertPaymentIntent(
        buildPaymentIntentUpsertFromEvent(syncedEvent, statusResponse),
      );
      if (intent.sessionType === 'OFFRAMP') {
        await syncWithdrawalLifecycleFromStatus(providerRef, statusResponse);
      }
      await deps.publisher.publishPaymentEvent(syncedEvent);

      console.log('[api-gateway][pouch] status synced', {
        userId: auth.user.id,
        providerRef: syncedEvent.providerReference,
        paymentId: syncedEvent.paymentId,
        status: syncedEvent.status,
        settlementReference: syncedEvent.settlementReference ?? null,
      });
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

async function syncWithdrawalLifecycleFromStatus(
  providerReference: string,
  statusResponse: Record<string, unknown>,
): Promise<void> {
  const lifecycleStatus = deriveLifecycleStatus(
    pickString(statusResponse, ['status']) ?? '',
  );
  const failureReason =
    pickString(statusResponse, ['failureReason', 'status']) ?? 'Withdrawal failed';

  if (lifecycleStatus === 'SETTLED') {
    await withdrawalClient.settle(providerReference).catch(() => null);
    return;
  }

  if (
    lifecycleStatus === 'FAILED' ||
    lifecycleStatus === 'EXPIRED' ||
    lifecycleStatus === 'CANCELLED'
  ) {
    await withdrawalClient
      .releaseFailedRequest({
        providerReference,
        failureReason,
        status: lifecycleStatus,
      })
      .catch(() => null);
    return;
  }

  await withdrawalClient.markProcessing(providerReference).catch(() => null);
}

function getWebhookSignature(req: IncomingMessage): string | null {
  const header = req.headers['x-webhook-signature'];
  if (typeof header === 'string' && header.trim().length > 0) {
    return header.trim();
  }

  if (Array.isArray(header)) {
    const first = header.find((value) => typeof value === 'string' && value.trim().length > 0);
    return first?.trim() ?? null;
  }

  return null;
}

function isValidWebhookSignature(
  rawBody: Buffer,
  signatureHeader: string,
  secret: string,
): boolean {
  const expectedHex = createHmac('sha256', secret).update(rawBody).digest('hex');
  const normalizedSignature = signatureHeader.startsWith('sha256=')
    ? signatureHeader.slice('sha256='.length)
    : signatureHeader;

  try {
    const provided = Buffer.from(normalizedSignature, 'hex');
    const expected = Buffer.from(expectedHex, 'hex');

    if (provided.length !== expected.length) {
      return false;
    }

    return timingSafeEqual(provided, expected);
  } catch {
    return false;
  }
}

function extractWebhookEventName(payload: Record<string, unknown>): string | null {
  return (
    pickString(payload, ['event', 'eventType', 'name']) ??
    pickString(payload, ['data.event', 'data.eventType', 'payload.event', 'payload.eventType']) ??
    null
  );
}

function unwrapWebhookPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const nested =
    (isRecord(payload['data']) && payload['data']) ||
    (isRecord(payload['payload']) && payload['payload']) ||
    (isRecord(payload['session']) && payload['session']) ||
    (isRecord(payload['transaction']) && payload['transaction']) ||
    (isRecord(payload['details']) && payload['details']);

  if (!nested) {
    return payload;
  }

  return {
    ...payload,
    ...nested,
  };
}

function shouldSyncPaymentIntentFromWebhook(eventName: string): boolean {
  const normalized = eventName.trim().toLowerCase();
  return (
    normalized === 'session.created' ||
    normalized === 'session.completed' ||
    normalized === 'session.failed' ||
    normalized === 'session.expired' ||
    normalized === 'transaction.pending' ||
    normalized === 'transaction.completed' ||
    normalized === 'transaction.failed'
  );
}

function inferWebhookStatus(eventName: string): string | undefined {
  const normalized = eventName.trim().toLowerCase();

  switch (normalized) {
    case 'session.created':
      return 'CREATED';
    case 'session.completed':
    case 'transaction.completed':
      return 'COMPLETED';
    case 'session.failed':
    case 'transaction.failed':
      return 'FAILED';
    case 'session.expired':
      return 'EXPIRED';
    case 'transaction.pending':
      return 'PENDING';
    case 'kyc.completed':
      return 'KYC_COMPLETED';
    case 'kyc.failed':
      return 'KYC_FAILED';
    default:
      return undefined;
  }
}

function inferWebhookSessionType(
  payload: Record<string, unknown>,
  fallback: PaymentSessionType,
): PaymentSessionType {
  const sessionType = pickString(payload, ['type', 'sessionType'])?.trim().toUpperCase();
  return sessionType === 'OFFRAMP' ? 'OFFRAMP' : sessionType === 'ONRAMP' ? 'ONRAMP' : fallback;
}

function enrichWebhookPayloadForIntent(
  payload: Record<string, unknown>,
  eventName: string,
  fallbackType: PaymentSessionType,
): Record<string, unknown> {
  const inferredStatus = inferWebhookStatus(eventName);
  const normalizedType = inferWebhookSessionType(payload, fallbackType);

  return {
    ...payload,
    status: pickString(payload, ['status', 'transaction.status']) ?? inferredStatus,
    type: normalizedType,
    providerRef:
      pickString(payload, [
        'providerRef',
        'reference',
        'paymentInstruction.reference',
        'cryptoInstruction.reference',
        'transaction.reference',
      ]) ?? undefined,
  };
}

function buildWebhookNotification(
  intent: NonNullable<Awaited<ReturnType<typeof paymentClient.findPaymentIntentByProviderReference>>>,
  eventName: string,
  _providerReference: string,
): InAppSendEvent | null {
  const normalized = eventName.trim().toLowerCase();
  const isOnramp = intent.sessionType === 'ONRAMP';

  let title: string | null = null;
  let body: string | null = null;
  let category: InAppSendEvent['category'] = 'payment';

  switch (normalized) {
    case 'transaction.pending':
      title = isOnramp ? 'Deposit processing' : 'Withdrawal processing';
      body = isOnramp
        ? 'Your deposit is being processed by Pouch.'
        : 'Your withdrawal is being processed by Pouch.';
      category = isOnramp ? 'payment' : 'wallet';
      break;
    case 'transaction.completed':
    case 'session.completed':
      title = isOnramp ? 'Deposit completed' : 'Withdrawal completed';
      body = isOnramp
        ? 'Your deposit has completed successfully.'
        : 'Your withdrawal has completed successfully.';
      category = isOnramp ? 'payment' : 'wallet';
      break;
    case 'transaction.failed':
    case 'session.failed':
      title = isOnramp ? 'Deposit failed' : 'Withdrawal failed';
      body = isOnramp
        ? 'Your deposit failed. Please try again.'
        : 'Your withdrawal failed. Please try again.';
      category = isOnramp ? 'payment' : 'wallet';
      break;
    case 'session.expired':
      title = isOnramp ? 'Deposit expired' : 'Withdrawal expired';
      body = isOnramp
        ? 'Your deposit session expired before completion.'
        : 'Your withdrawal session expired before completion.';
      category = isOnramp ? 'payment' : 'wallet';
      break;
    case 'kyc.completed':
      title = 'KYC completed';
      body = 'Your Pouch KYC verification completed successfully.';
      category = 'kyc';
      break;
    case 'kyc.failed':
      title = 'KYC failed';
      body = 'Your Pouch KYC verification failed. Please review your details.';
      category = 'kyc';
      break;
    default:
      return null;
  }

  return {
    eventType: 'IN_APP_SEND',
    notificationId: randomUUID(),
    userId: intent.userId,
    title,
    body,
    category,
    referenceId: intent.paymentId,
    referenceType: 'payment',
    read: false,
    timestamp: new Date().toISOString(),
  };
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
    console.warn('[api-gateway][pouch] missing bearer token');
    throw new Error('Authorization bearer token is required');
  }

  const verifiedToken = verifyPrivyAccessToken({
    accessToken: token,
    appId,
    verificationKey,
  });

  const user = await userClient.findByPrivyDid(verifiedToken.privyDid);
  if (!user) {
    console.warn('[api-gateway][pouch] privy user not registered', {
      privyDid: verifiedToken.privyDid,
    });
    throw new Error('User not registered. Call POST /auth/privy first.');
  }

  return { user, verifiedToken };
}

async function buildOnrampPayload(
  body: Record<string, unknown>,
  defaults: PouchRouteDeps['defaults'],
  ridePricingDisplayProvider: RidePricingDisplayProvider,
): Promise<PouchOnrampPayload> {
  const amountLocal = pickNumber(body, ['amountLocal', 'localAmount', 'ngnAmount']);
  if (!amountLocal || amountLocal <= 0) {
    throw new Error('amountLocal must be a positive number in local currency');
  }

  const userKyc = readUserKyc(body['userKyc'], defaults.userKycDefaults);
  const pricing = await ridePricingDisplayProvider.getPricingDisplay();
  const amountUsd = amountLocal / pricing.displayExchangeRate;

  if (!Number.isFinite(amountUsd) || amountUsd <= 0) {
    throw new Error('Could not convert local amount into a valid USD amount for Pouch');
  }

  return {
    amount: roundAmount(amountUsd),
    cryptoCurrency:
      pickString(body, ['cryptoCurrency'])?.toUpperCase() ?? defaults.cryptoCurrency,
    cryptoNetwork:
      pickString(body, ['cryptoNetwork'])?.toUpperCase() ?? defaults.cryptoNetwork,
    walletAddress: defaults.masterWalletAddress,
    walletTag: pickString(body, ['walletTag']) ?? buildPouchWalletTag(),
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

  const userKyc = readUserKyc(body['userKyc'], defaults.userKycDefaults);

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

function readUserKyc(
  value: unknown,
  defaults?: Record<string, string>,
): Record<string, unknown> | null {
  const mergedDefaults = defaults && Object.keys(defaults).length > 0 ? defaults : undefined;

  if (isRecord(value)) {
    const normalizedInput = normalizePouchUserKyc(value);
    return mergedDefaults
      ? {
          ...mergedDefaults,
          ...normalizedInput,
        }
      : normalizedInput;
  }

  return mergedDefaults ?? null;
}

function resolveCustomerEmail(
  body: Record<string, unknown>,
  verifiedToken: ReturnType<typeof verifyPrivyAccessToken>,
  fallbackEmail?: string,
): string | undefined {
  return (
    pickString(body, ['email']) ??
    (typeof verifiedToken.claims['email'] === 'string'
      ? verifiedToken.claims['email']
      : undefined) ??
    fallbackEmail
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
    console.error('[api-gateway][pouch] provider api error', {
      fallbackMessage,
      statusCode: error.statusCode,
      responseBody: error.responseBody,
    });
    sendJson(res, error.statusCode, {
      error: fallbackMessage,
      details: error.responseBody,
    });
    return;
  }

  console.error('[api-gateway][pouch] route error', {
    fallbackMessage,
    error: error instanceof Error ? error.message : String(error),
  });

  sendJson(res, 400, {
    error: error instanceof Error ? error.message : fallbackMessage,
  });
}

function summarizeOnrampPayload(
  payload: PouchOnrampPayload,
  input: Record<string, unknown>,
) {
  return {
    amountLocalInput:
      pickNumber(input, ['amountLocal', 'localAmount', 'ngnAmount']) ?? null,
    amountUsdSent: payload.amount,
    countryCode: payload.countryCode,
    currency: payload.currency,
    cryptoCurrency: payload.cryptoCurrency,
    cryptoNetwork: payload.cryptoNetwork,
    providerId: payload.providerId,
    walletAddress: maskIdentifier(payload.walletAddress),
    walletTag: payload.walletTag ?? null,
    userKycFields: payload.userKyc ? Object.keys(payload.userKyc) : [],
    userKyc: maskSensitiveRecord(payload.userKyc),
  };
}

function summarizeOfframpPayload(payload: PouchOfframpPayload) {
  return {
    cryptoAmount: payload.cryptoAmount,
    countryCode: payload.countryCode,
    currency: payload.currency,
    cryptoCurrency: payload.cryptoCurrency,
    cryptoNetwork: payload.cryptoNetwork,
    providerId: payload.providerId,
    bankAccount: {
      accountNumber: maskIdentifier(payload.bankAccount.accountNumber),
      accountName: payload.bankAccount.accountName,
      networkId: payload.bankAccount.networkId,
    },
    userKycFields: payload.userKyc ? Object.keys(payload.userKyc) : [],
    userKyc: maskSensitiveRecord(payload.userKyc),
  };
}

function summarizeCreateResponse(response: Record<string, unknown>) {
  return {
    providerRef: pickString(response, ['providerRef']) ?? null,
    reference:
      pickString(response, ['paymentInstruction.reference', 'cryptoInstruction.reference']) ??
      null,
    amountLocal:
      pickNumber(response, ['paymentInstruction.amountLocal', 'cryptoInstruction.amountLocal']) ??
      null,
    amountUsd:
      pickNumber(response, ['paymentInstruction.amountUsd', 'cryptoInstruction.amountUsd']) ??
      null,
    accountNumber: maskIdentifier(
      pickString(response, ['paymentInstruction.accountNumber']) ?? undefined,
    ),
    walletAddress: maskIdentifier(
      pickString(response, ['cryptoInstruction.walletAddress']) ?? undefined,
    ),
  };
}

function summarizeStatusResponse(response: Record<string, unknown>) {
  return {
    providerRef: pickString(response, ['providerRef']) ?? null,
    status: pickString(response, ['status']) ?? null,
    type: pickString(response, ['type']) ?? null,
    transactionHash: maskIdentifier(pickString(response, ['transactionHash']) ?? undefined),
    settlementTransactionHash: maskIdentifier(
      pickString(response, ['settlementInfo.transactionHash']) ?? undefined,
    ),
    cryptoAmount: pickNumber(response, ['settlementInfo.cryptoAmount']) ?? null,
    cryptoCurrency: pickString(response, ['settlementInfo.cryptoCurrency']) ?? null,
    cryptoNetwork: pickString(response, ['settlementInfo.cryptoNetwork']) ?? null,
    failureReason: pickString(response, ['failureReason']) ?? null,
  };
}

function maskIdentifier(value: string | undefined): string | null {
  if (!value) {
    return null;
  }

  if (value.length <= 10) {
    return value;
  }

  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function maskSensitiveRecord(
  value: Record<string, unknown> | undefined,
): Record<string, unknown> | null {
  if (!value) {
    return null;
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, entryValue]) => [key, maskSensitiveValue(key, entryValue)]),
  );
}

function maskSensitiveValue(key: string, value: unknown): unknown {
  if (typeof value !== 'string') {
    return value;
  }

  const normalizedKey = key.toLowerCase();
  if (normalizedKey.includes('email')) {
    return maskEmail(value);
  }

  if (
    normalizedKey.includes('phone') ||
    normalizedKey.includes('address') ||
    normalizedKey.includes('name') ||
    normalizedKey.includes('nin') ||
    normalizedKey.includes('bvn') ||
    normalizedKey.includes('dob')
  ) {
    return maskIdentifier(value);
  }

  return value;
}

function maskEmail(value: string): string {
  const atIndex = value.indexOf('@');
  if (atIndex <= 1) {
    return maskIdentifier(value) ?? value;
  }

  return `${value.slice(0, 2)}***${value.slice(atIndex)}`;
}

function buildPouchWalletTag(): string {
  const timestamp = Date.now().toString();
  const suffix = randomInt(100_000, 1_000_000).toString();
  return `${timestamp}${suffix}`;
}

function normalizePouchUserKyc(value: Record<string, unknown>): Record<string, unknown> {
  const normalizedEntries = Object.entries(value).map(([key, entryValue]) => {
    const normalizedKey = normalizePouchUserKycKey(key);
    const normalizedValue =
      normalizedKey === 'DOB' && typeof entryValue === 'string'
        ? normalizePouchDob(entryValue)
        : entryValue;

    return [normalizedKey, normalizedValue];
  });

  return Object.fromEntries(normalizedEntries);
}

function normalizePouchUserKycKey(key: string): string {
  const compact = key.replace(/[\s-]+/g, '_');
  const upper = compact.toUpperCase();

  if (upper === 'FULLNAME') {
    return 'FULL_NAME';
  }

  return upper;
}

function normalizePouchDob(value: string): string {
  const trimmed = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return trimmed;
  }

  const slashMatch = trimmed.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (slashMatch) {
    const [, month, day, year] = slashMatch;
    return `${year}-${month}-${day}`;
  }

  return trimmed;
}
