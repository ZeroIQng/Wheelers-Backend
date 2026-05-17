const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildPouchMetadata,
  normalizePouchTransactionCreated,
  normalizePouchTransactionStatus,
  readPouchMetadata,
} = require('../apps/api-gateway/dist/http/pouch.helpers.js');
const {
  buildIntentUpsertPayload,
  deriveLifecycleStatus,
} = require('../apps/payment-service/dist/domain/payment-intent.js');
const {
  inferOnrampSettlement,
} = require('../apps/payment-service/dist/domain/pouch-session.js');

test('readPouchMetadata normalizes serialized metadata', () => {
  const metadata = buildPouchMetadata({
    userId: '42d2cb9d-1afe-4a49-b08a-b7cc611fd0de',
    walletAddress: '0xABCDEF1234567890ABCDEF1234567890ABCDEF12',
  });

  const parsed = readPouchMetadata(JSON.stringify(metadata));

  assert.deepEqual(parsed, {
    userId: '42d2cb9d-1afe-4a49-b08a-b7cc611fd0de',
    walletAddress: '0xabcdef1234567890abcdef1234567890abcdef12',
    initiatedBy: 'api-gateway',
  });
});

test('normalizePouchTransactionCreated maps a direct onramp into PAYMENT_SESSION_CREATED', () => {
  const event = normalizePouchTransactionCreated({
    type: 'ONRAMP',
    payload: {
      providerRef: 'pouch-onramp-123',
      paymentInstruction: {
        amountUsd: 4,
        amountLocal: 6200,
        localCurrency: 'NGN',
        cryptoAmount: 4,
        cryptoCurrency: 'USDC',
        cryptoNetwork: 'XLM',
      },
    },
    metadata: {
      userId: '42d2cb9d-1afe-4a49-b08a-b7cc611fd0de',
      walletAddress: '0xABCDEF1234567890ABCDEF1234567890ABCDEF12',
      initiatedBy: 'api-gateway',
    },
    customerEmail: 'rider@example.com',
    chain: 'XLM',
  });

  assert.ok(event);
  assert.equal(event.eventType, 'PAYMENT_SESSION_CREATED');
  assert.equal(event.paymentProvider, 'pouch');
  assert.equal(event.providerReference, 'pouch-onramp-123');
  assert.equal(event.sessionType, 'ONRAMP');
  assert.equal(event.amountUsd, 4);
  assert.equal(event.amountLocal, 6200);
  assert.equal(event.localCurrency, 'NGN');
  assert.equal(event.cryptoCurrency, 'USDC');
  assert.equal(event.cryptoNetwork, 'XLM');
  assert.equal(event.userWallet, '0xabcdef1234567890abcdef1234567890abcdef12');
  assert.equal(event.customerEmail, 'rider@example.com');
});

test('normalizePouchTransactionStatus maps ramp status into PAYMENT_SESSION_SYNCED', () => {
  const event = normalizePouchTransactionStatus({
    payload: {
      providerRef: 'pouch-onramp-456',
      status: 'completed',
      type: 'ONRAMP',
      transactionHash: 'pouch_ref_789',
      settlementInfo: {
        cryptoAmount: 4,
        cryptoCurrency: 'USDC',
        cryptoNetwork: 'XLM',
      },
      details: {
        amountUsd: 4,
        amountLocal: 6200,
        localCurrency: 'NGN',
      },
    },
    intent: {
      paymentId: '2e2cc892-a564-4e0d-b733-19399eb0fc8a',
      userId: '42d2cb9d-1afe-4a49-b08a-b7cc611fd0de',
      provider: 'pouch',
      providerReference: 'pouch-onramp-456',
      sessionType: 'ONRAMP',
      lifecycleStatus: 'PENDING',
      providerStatus: 'PENDING',
      userWallet: '0xabcdef1234567890abcdef1234567890abcdef12',
      amountUsd: 4,
      amountLocal: 6200,
      localCurrency: 'NGN',
      cryptoCurrency: 'USDC',
      cryptoNetwork: 'XLM',
      cryptoAmount: 4,
      chain: 'XLM',
      customerEmail: null,
      walletTag: null,
      settlementReference: null,
      providerPayload: null,
      metadata: null,
      lastSyncedAt: null,
      settledAt: null,
      failedAt: null,
      expiresAt: null,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      id: 'intent-1',
    },
  });

  assert.ok(event);
  assert.equal(event.eventType, 'PAYMENT_SESSION_SYNCED');
  assert.equal(event.paymentProvider, 'pouch');
  assert.equal(event.providerReference, 'pouch-onramp-456');
  assert.equal(event.amountUsd, 4);
  assert.equal(event.amountLocal, 6200);
  assert.equal(event.cryptoAmount, 4);
  assert.equal(event.cryptoCurrency, 'USDC');
  assert.equal(event.cryptoNetwork, 'XLM');
  assert.equal(event.settlementReference, 'pouch_ref_789');
});

test('inferOnrampSettlement turns a synced stablecoin onramp into ONRAMP_SETTLED', () => {
  const synced = normalizePouchTransactionStatus({
    payload: {
      providerRef: 'sess_789',
      type: 'ONRAMP',
      status: 'completed',
      transactionHash: 'pouch_ref_101',
      settlementInfo: {
        cryptoAmount: 7,
        cryptoCurrency: 'USDT',
        cryptoNetwork: 'ERC20',
      },
      details: {
        amountUsd: 7,
        amountLocal: 10850,
        localCurrency: 'NGN',
      },
    },
    intent: buildIntentFixture({
      providerReference: 'sess_789',
      cryptoCurrency: 'USDT',
      cryptoNetwork: 'ERC20',
      amountUsd: 7,
      amountLocal: 10850,
      cryptoAmount: 7,
    }),
  });

  const event = inferOnrampSettlement(synced);

  assert.ok(event);
  assert.equal(event.eventType, 'ONRAMP_SETTLED');
  assert.equal(event.amountUsdt, 7);
  assert.equal(event.settlementReference, 'pouch_ref_101');
});

test('inferOnrampSettlement ignores unsupported wallet credit assets', () => {
  const synced = normalizePouchTransactionStatus({
    payload: {
      providerRef: 'sess_btc',
      type: 'ONRAMP',
      status: 'completed',
      settlementInfo: {
        cryptoAmount: 0.001,
        cryptoCurrency: 'BTC',
        cryptoNetwork: 'BTC',
      },
      details: {
        amountUsd: 50,
        localCurrency: 'NGN',
      },
    },
    intent: buildIntentFixture({
      providerReference: 'sess_btc',
      cryptoCurrency: 'BTC',
      cryptoNetwork: 'BTC',
      amountUsd: 50,
      cryptoAmount: 0.001,
    }),
  });

  const event = inferOnrampSettlement(synced);

  assert.equal(event, null);
});

test('deriveLifecycleStatus maps provider session states into internal lifecycle states', () => {
  assert.equal(deriveLifecycleStatus('pending'), 'PENDING');
  assert.equal(deriveLifecycleStatus('otp_required'), 'REQUIRES_USER_ACTION');
  assert.equal(deriveLifecycleStatus('processing'), 'PROCESSING');
  assert.equal(deriveLifecycleStatus('completed'), 'SETTLED');
  assert.equal(deriveLifecycleStatus('kyc_failed'), 'FAILED');
  assert.equal(deriveLifecycleStatus('expired'), 'EXPIRED');
});

test('buildIntentUpsertPayload creates payment-owned session tracking data from a sync event', () => {
  const synced = normalizePouchTransactionStatus({
    payload: {
      providerRef: 'sess_intent',
      type: 'OFFRAMP',
      status: 'processing',
      transactionHash: 'pouch_ref_intent',
      settlementInfo: {
        cryptoAmount: 12,
        cryptoCurrency: 'USDC',
        cryptoNetwork: 'XLM',
      },
      details: {
        amountUsd: 12,
        amountLocal: 18000,
        localCurrency: 'NGN',
      },
    },
    intent: buildIntentFixture({
      providerReference: 'sess_intent',
      sessionType: 'OFFRAMP',
      amountUsd: 12,
      amountLocal: 18000,
      cryptoAmount: 12,
    }),
  });

  const payload = buildIntentUpsertPayload(synced);

  assert.equal(payload.sessionType, 'OFFRAMP');
  assert.equal(payload.lifecycleStatus, 'PROCESSING');
  assert.equal(payload.providerReference, 'sess_intent');
  assert.equal(payload.amountUsd, 12);
  assert.equal(payload.amountLocal, 18000);
  assert.equal(payload.cryptoAmount, 12);
  assert.equal(payload.settlementReference, 'pouch_ref_intent');
});

function buildIntentFixture(overrides = {}) {
  return {
    paymentId: '2e2cc892-a564-4e0d-b733-19399eb0fc8a',
    userId: '42d2cb9d-1afe-4a49-b08a-b7cc611fd0de',
    provider: 'pouch',
    providerReference: 'fixture-ref',
    sessionType: 'ONRAMP',
    lifecycleStatus: 'PENDING',
    providerStatus: 'PENDING',
    userWallet: '0xabcdef1234567890abcdef1234567890abcdef12',
    amountUsd: 4,
    amountLocal: 6200,
    localCurrency: 'NGN',
    cryptoCurrency: 'USDC',
    cryptoNetwork: 'XLM',
    cryptoAmount: 4,
    chain: 'XLM',
    customerEmail: null,
    walletTag: null,
    settlementReference: null,
    providerPayload: null,
    metadata: null,
    lastSyncedAt: null,
    settledAt: null,
    failedAt: null,
    expiresAt: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    id: 'intent-fixture',
    ...overrides,
  };
}
