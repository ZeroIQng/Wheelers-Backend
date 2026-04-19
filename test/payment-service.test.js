const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildPouchMetadata,
  normalizePouchOnrampSettled,
  normalizePouchSessionCreated,
  readPouchMetadata,
} = require('../apps/api-gateway/dist/http/pouch.helpers.js');

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

test('normalizePouchOnrampSettled maps a completed stablecoin session into ONRAMP_SETTLED', () => {
  const event = normalizePouchOnrampSettled({
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
  assert.equal(event.eventType, 'ONRAMP_SETTLED');
  assert.equal(event.paymentProvider, 'pouch');
  assert.equal(event.providerReference, 'sess_456');
  assert.equal(event.amountUsd, 4);
  assert.equal(event.amountLocal, 6200);
  assert.equal(event.amountUsdt, 4);
  assert.equal(event.cryptoCurrency, 'USDC');
  assert.equal(event.cryptoNetwork, 'XLM');
  assert.equal(event.settlementReference, 'pouch_ref_789');
});

test('normalizePouchOnrampSettled ignores unsupported wallet credit assets', () => {
  const event = normalizePouchOnrampSettled({
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

  assert.equal(event, null);
});
