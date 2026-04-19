import type { IncomingMessage, ServerResponse } from 'http';
import { userClient } from '@wheleers/db';
import { verifyPrivyAccessToken } from '../auth/privy';
import { getString, isRecord, pickNumber, pickString } from '../utils/object';
import type { GatewayPublisher } from '../websocket/publisher';
import {
  buildPouchMetadata,
  normalizePouchSessionCreated,
  normalizePouchSessionSynced,
  pouchSessionBelongsToUser,
} from './pouch.helpers';
import {
  PouchApiError,
  PouchClient,
  type PouchSessionPayload,
} from './pouch.client';
import { readJsonBody, sendJson } from './utils';

interface PouchRouteDeps {
  privyAppId: string;
  privyVerificationKey: string;
  pouchClient: PouchClient;
  publisher: GatewayPublisher;
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

export async function handlePouchChannelsRoute(
  _req: IncomingMessage,
  res: ServerResponse,
  deps: PouchHealthRouteDeps,
): Promise<void> {
  try {
    const channels = await deps.pouchClient.getCryptoChannels();
    sendJson(res, 200, channels);
  } catch (error) {
    sendPouchError(res, error, 'Failed to load Pouch channels');
  }
}

export async function handlePouchCreateSessionRoute(
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
    const payload = buildCreateSessionPayload(rawBody, auth);
    const session = await deps.pouchClient.createSession(payload);
    const createdEvent = normalizePouchSessionCreated(session);

    if (createdEvent) {
      await deps.publisher.publishPaymentEvent(createdEvent);
    }

    sendJson(res, 200, {
      provider: 'pouch',
      session,
      walletCreditable:
        payload.type === 'ONRAMP' &&
        ['USDT', 'USDC'].includes(payload.cryptoCurrency.toUpperCase()),
    });
  } catch (error) {
    sendPouchError(res, error, 'Failed to create Pouch session');
  }
}

export async function handlePouchGetSessionRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: PouchRouteDeps,
  sessionId: string,
): Promise<void> {
  try {
    const auth = await authenticateHttpUser(req, deps.privyAppId, deps.privyVerificationKey);
    const session = await deps.pouchClient.getSession(sessionId);

    if (!pouchSessionBelongsToUser(session, auth.user.id)) {
      sendJson(res, 403, { error: 'This session does not belong to the authenticated user' });
      return;
    }

    const syncedEvent = normalizePouchSessionSynced(session);
    if (syncedEvent) {
      await deps.publisher.publishPaymentEvent(syncedEvent);
    }

    sendJson(res, 200, {
      provider: 'pouch',
      session,
      sessionSynced: Boolean(syncedEvent),
    });
  } catch (error) {
    sendPouchError(res, error, 'Failed to load Pouch session');
  }
}

export async function handlePouchQuoteRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: PouchRouteDeps,
  sessionId: string,
): Promise<void> {
  try {
    const auth = await authenticateHttpUser(req, deps.privyAppId, deps.privyVerificationKey);
    await assertSessionOwnership(auth.user.id, sessionId, deps.pouchClient);
    const quote = await deps.pouchClient.getSessionQuote(sessionId);
    sendJson(res, 200, { provider: 'pouch', sessionId, quote });
  } catch (error) {
    sendPouchError(res, error, 'Failed to load Pouch quote');
  }
}

export async function handlePouchIdentifyRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: PouchRouteDeps,
  sessionId: string,
): Promise<void> {
  try {
    const rawBody = await readJsonBody(req);
    if (!isRecord(rawBody)) {
      sendJson(res, 400, { error: 'Body must be a JSON object' });
      return;
    }

    const auth = await authenticateHttpUser(req, deps.privyAppId, deps.privyVerificationKey);
    await assertSessionOwnership(auth.user.id, sessionId, deps.pouchClient);

    const email =
      pickString(rawBody, ['email']) ??
      (typeof auth.verifiedToken.claims['email'] === 'string'
        ? auth.verifiedToken.claims['email']
        : undefined);

    if (!email) {
      sendJson(res, 400, { error: 'email is required to identify a Pouch session' });
      return;
    }

    const response = await deps.pouchClient.identifySession(sessionId, email);
    sendJson(res, 200, { provider: 'pouch', sessionId, response });
  } catch (error) {
    sendPouchError(res, error, 'Failed to identify Pouch session');
  }
}

export async function handlePouchVerifyOtpRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: PouchRouteDeps,
  sessionId: string,
): Promise<void> {
  try {
    const rawBody = await readJsonBody(req);
    if (!isRecord(rawBody)) {
      sendJson(res, 400, { error: 'Body must be a JSON object' });
      return;
    }

    const auth = await authenticateHttpUser(req, deps.privyAppId, deps.privyVerificationKey);
    await assertSessionOwnership(auth.user.id, sessionId, deps.pouchClient);

    const code = pickString(rawBody, ['code', 'otp']);
    if (!code) {
      sendJson(res, 400, { error: 'code is required to verify OTP' });
      return;
    }

    const response = await deps.pouchClient.verifyOtp(sessionId, code);
    sendJson(res, 200, { provider: 'pouch', sessionId, response });
  } catch (error) {
    sendPouchError(res, error, 'Failed to verify Pouch OTP');
  }
}

export async function handlePouchKycRequirementsRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: PouchRouteDeps,
  sessionId: string,
): Promise<void> {
  try {
    const auth = await authenticateHttpUser(req, deps.privyAppId, deps.privyVerificationKey);
    await assertSessionOwnership(auth.user.id, sessionId, deps.pouchClient);
    const requirements = await deps.pouchClient.getKycRequirements(sessionId);
    sendJson(res, 200, { provider: 'pouch', sessionId, requirements });
  } catch (error) {
    sendPouchError(res, error, 'Failed to load Pouch KYC requirements');
  }
}

export async function handlePouchSubmitKycRoute(
  req: IncomingMessage,
  res: ServerResponse,
  deps: PouchRouteDeps,
  sessionId: string,
): Promise<void> {
  try {
    const rawBody = await readJsonBody(req);
    if (!isRecord(rawBody)) {
      sendJson(res, 400, { error: 'Body must be a JSON object' });
      return;
    }

    const auth = await authenticateHttpUser(req, deps.privyAppId, deps.privyVerificationKey);
    await assertSessionOwnership(auth.user.id, sessionId, deps.pouchClient);

    const documents = rawBody['documents'];
    if (!isRecord(documents)) {
      sendJson(res, 400, { error: 'documents must be a JSON object' });
      return;
    }

    const response = await deps.pouchClient.submitKyc(sessionId, documents);
    sendJson(res, 200, { provider: 'pouch', sessionId, response });
  } catch (error) {
    sendPouchError(res, error, 'Failed to submit Pouch KYC');
  }
}

async function assertSessionOwnership(
  userId: string,
  sessionId: string,
  pouchClient: PouchClient,
): Promise<void> {
  const session = await pouchClient.getSession(sessionId);
  if (!pouchSessionBelongsToUser(session, userId)) {
    throw new Error('This session does not belong to the authenticated user');
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

function buildCreateSessionPayload(
  body: Record<string, unknown>,
  auth: {
    user: NonNullable<Awaited<ReturnType<typeof userClient.findByPrivyDid>>>;
    verifiedToken: ReturnType<typeof verifyPrivyAccessToken>;
  },
): PouchSessionPayload {
  const type = pickString(body, ['type'])?.toUpperCase();
  const amount = pickNumber(body, ['amount', 'amountUsd', 'amountUSD']);
  const countryCode = pickString(body, ['countryCode'])?.toUpperCase();
  const currency = pickString(body, ['currency', 'localCurrency'])?.toUpperCase();
  const cryptoCurrency = pickString(body, ['cryptoCurrency'])?.toUpperCase();
  const cryptoNetwork = pickString(body, ['cryptoNetwork'])?.toUpperCase();
  const walletAddress =
    pickString(body, ['walletAddress'])?.toLowerCase() ?? auth.user.walletAddress.toLowerCase();

  if ((type !== 'ONRAMP' && type !== 'OFFRAMP') || !amount || amount <= 0) {
    throw new Error('type must be ONRAMP or OFFRAMP and amount must be a positive number');
  }

  if (!countryCode || !currency || !cryptoCurrency || !cryptoNetwork) {
    throw new Error(
      'countryCode, currency, cryptoCurrency, and cryptoNetwork are required for a Pouch session',
    );
  }

  const metadata = isRecord(body['metadata']) ? body['metadata'] : {};
  const email =
    pickString(body, ['email']) ??
    (typeof auth.verifiedToken.claims['email'] === 'string'
      ? auth.verifiedToken.claims['email']
      : undefined);

  const payload: PouchSessionPayload = {
    ...(body as PouchSessionPayload),
    type,
    amount,
    countryCode,
    currency,
    cryptoCurrency,
    cryptoNetwork,
    walletAddress,
    metadata: {
      ...metadata,
      ...buildPouchMetadata({
        userId: auth.user.id,
        walletAddress,
      }),
    },
  };

  const chain = pickString(body, ['chain'])?.toUpperCase();
  if (chain) {
    payload['chain'] = chain;
  }

  const walletTag = pickString(body, ['walletTag', 'memo', 'tag']);
  if (walletTag) {
    payload['walletTag'] = walletTag;
  }

  if (email) {
    payload['email'] = email;
  }

  return payload;
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
