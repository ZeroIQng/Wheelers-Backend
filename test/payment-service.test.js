const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildPouchMetadata,
  normalizePouchSessionCreated,
  normalizePouchSessionSynced,
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

test('normalizePouchSessionCreated maps a Pouch session into PAYMENT_SESSION_CREATED', () => {
  const event = normalizePouchSessionCreated({
    id: 'sess_123',
    type: 'ONRAMP',
    status: 'pending',
    amount: 4,
    currency: 'NGN',
    cryptoCurrency: 'USDC',
    cryptoNetwork: 'XLM',
    chain: 'XLM',
    walletAddress: '0xABCDEF1234567890ABCDEF1234567890ABCDEF12',
    email: 'rider@example.com',
    metadata: {
      userId: '42d2cb9d-1afe-4a49-b08a-b7cc611fd0de',
      walletAddress: '0xABCDEF1234567890ABCDEF1234567890ABCDEF12',
    },
    paymentInstruction: {
      amountLocal: 6200,
    },
  });

  assert.ok(event);
  assert.equal(event.eventType, 'PAYMENT_SESSION_CREATED');
  assert.equal(event.paymentProvider, 'pouch');
  assert.equal(event.providerReference, 'sess_123');
  assert.equal(event.sessionType, 'ONRAMP');
  assert.equal(event.amountUsd, 4);
  assert.equal(event.amountLocal, 6200);
  assert.equal(event.localCurrency, 'NGN');
  assert.equal(event.cryptoCurrency, 'USDC');
  assert.equal(event.cryptoNetwork, 'XLM');
  assert.equal(event.userWallet, '0xabcdef1234567890abcdef1234567890abcdef12');
});

test('normalizePouchSessionSynced maps a fetched Pouch session into PAYMENT_SESSION_SYNCED', () => {
  const event = normalizePouchSessionSynced({
    id: 'sess_456',
    type: 'ONRAMP',
    status: 'completed',
    amount: 4,
    currency: 'NGN',
    cryptoCurrency: 'USDC',
    cryptoNetwork: 'XLM',
    chain: 'XLM',
    metadata: {
      userId: '42d2cb9d-1afe-4a49-b08a-b7cc611fd0de',
      walletAddress: '0xABCDEF1234567890ABCDEF1234567890ABCDEF12',
    },
    paymentInstruction: {
      amountLocal: 6200,
      cryptoAmount: 4,
      cryptoCurrency: 'USDC',
      cryptoNetwork: 'XLM',
      reference: 'pouch_ref_789',
    },
  });

  assert.ok(event);
  assert.equal(event.eventType, 'PAYMENT_SESSION_SYNCED');
  assert.equal(event.paymentProvider, 'pouch');
  assert.equal(event.providerReference, 'sess_456');
  assert.equal(event.amountUsd, 4);
  assert.equal(event.amountLocal, 6200);
  assert.equal(event.cryptoAmount, 4);
  assert.equal(event.cryptoCurrency, 'USDC');
  assert.equal(event.cryptoNetwork, 'XLM');
  assert.equal(event.settlementReference, 'pouch_ref_789');
});

test('inferOnrampSettlement turns a synced stablecoin onramp into ONRAMP_SETTLED', () => {
  const synced = normalizePouchSessionSynced({
    id: 'sess_789',
    type: 'ONRAMP',
    status: 'completed',
    amount: 7,
    currency: 'NGN',
    cryptoCurrency: 'USDT',
    cryptoNetwork: 'ERC20',
    metadata: {
      userId: '42d2cb9d-1afe-4a49-b08a-b7cc611fd0de',
      walletAddress: '0xABCDEF1234567890ABCDEF1234567890ABCDEF12',
    },
    paymentInstruction: {
      amountLocal: 10850,
      cryptoAmount: 7,
      cryptoCurrency: 'USDT',
      cryptoNetwork: 'ERC20',
      reference: 'pouch_ref_101',
    },
  });

  const event = inferOnrampSettlement(synced);

  assert.ok(event);
  assert.equal(event.eventType, 'ONRAMP_SETTLED');
  assert.equal(event.amountUsdt, 7);
  assert.equal(event.settlementReference, 'pouch_ref_101');
});

test('inferOnrampSettlement ignores unsupported wallet credit assets', () => {
  const synced = normalizePouchSessionSynced({
    id: 'sess_btc',
    type: 'ONRAMP',
    status: 'completed',
    amount: 50,
    currency: 'NGN',
    cryptoCurrency: 'BTC',
    cryptoNetwork: 'BTC',
    metadata: {
      userId: '42d2cb9d-1afe-4a49-b08a-b7cc611fd0de',
      walletAddress: '0xABCDEF1234567890ABCDEF1234567890ABCDEF12',
    },
    paymentInstruction: {
      cryptoAmount: 0.001,
      cryptoCurrency: 'BTC',
      cryptoNetwork: 'BTC',
    },
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
  const synced = normalizePouchSessionSynced({
    id: 'sess_intent',
    type: 'OFFRAMP',
    status: 'processing',
    amount: 12,
    currency: 'NGN',
    cryptoCurrency: 'USDC',
    cryptoNetwork: 'XLM',
    metadata: {
      userId: '42d2cb9d-1afe-4a49-b08a-b7cc611fd0de',
      walletAddress: '0xABCDEF1234567890ABCDEF1234567890ABCDEF12',
    },
    paymentInstruction: {
      amountLocal: 18000,
      cryptoAmount: 12,
      cryptoCurrency: 'USDC',
      cryptoNetwork: 'XLM',
      reference: 'pouch_ref_intent',
    },
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
