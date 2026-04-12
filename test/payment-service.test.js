const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const {
  buildPaystackMetadata,
  normalizePaystackChargeSuccess,
  readPaystackMetadata,
  verifyPaystackSignature,
} = require('../apps/api-gateway/dist/http/paystack.helpers.js');
const { convertNgnToUsdt } = require('../apps/payment-service/dist/fx/conversion.js');

test('verifyPaystackSignature accepts a valid signature', () => {
  const rawBody = Buffer.from(JSON.stringify({ event: 'charge.success', data: { reference: 'abc' } }));
  const secret = 'sk_test_signature';
  const signature = crypto.createHmac('sha512', secret).update(rawBody).digest('hex');

  assert.equal(verifyPaystackSignature(rawBody, signature, secret), true);
  assert.equal(verifyPaystackSignature(rawBody, 'bad-signature', secret), false);
});

test('readPaystackMetadata normalizes serialized metadata', () => {
  const metadata = buildPaystackMetadata({
    userId: '42d2cb9d-1afe-4a49-b08a-b7cc611fd0de',
    walletAddress: '0xABCDEF1234567890ABCDEF1234567890ABCDEF12',
  });

  const parsed = readPaystackMetadata(JSON.stringify(metadata));

  assert.deepEqual(parsed, {
    userId: '42d2cb9d-1afe-4a49-b08a-b7cc611fd0de',
    walletAddress: '0xabcdef1234567890abcdef1234567890abcdef12',
    initiatedBy: 'api-gateway',
  });
});

test('normalizePaystackChargeSuccess maps a Paystack success payload into DEPOSIT_RECEIVED', () => {
  const event = normalizePaystackChargeSuccess({
    status: 'success',
    reference: 'wheelers_reference_123',
    amount: 250000,
    currency: 'NGN',
    channel: 'bank_transfer',
    paid_at: '2025-04-11T10:00:00.000Z',
    customer: {
      email: 'rider@example.com',
    },
    metadata: {
      userId: '42d2cb9d-1afe-4a49-b08a-b7cc611fd0de',
      walletAddress: '0xABCDEF1234567890ABCDEF1234567890ABCDEF12',
    },
    authorization: {
      receiver_bank_account_number: '0123456789',
    },
  });

  assert.ok(event);
  assert.equal(event.eventType, 'DEPOSIT_RECEIVED');
  assert.equal(event.paymentProvider, 'paystack');
  assert.equal(event.providerReference, 'wheelers_reference_123');
  assert.equal(event.amountNgn, 2500);
  assert.equal(event.paymentChannel, 'bank_transfer');
  assert.equal(event.customerEmail, 'rider@example.com');
  assert.equal(event.virtualAccountNumber, '0123456789');
  assert.equal(event.userWallet, '0xabcdef1234567890abcdef1234567890abcdef12');
});

test('normalizePaystackChargeSuccess rejects payloads without Wheelers metadata', () => {
  const event = normalizePaystackChargeSuccess({
    status: 'success',
    reference: 'missing_metadata',
    amount: 100000,
    currency: 'NGN',
  });

  assert.equal(event, null);
});

test('convertNgnToUsdt rounds to 6 decimal places and validates inputs', () => {
  assert.deepEqual(convertNgnToUsdt(15000, 1500), {
    amountUsdt: 10,
    exchangeRate: 1500,
  });

  assert.deepEqual(convertNgnToUsdt(5250, 1575), {
    amountUsdt: 3.333333,
    exchangeRate: 1575,
  });

  assert.throws(() => convertNgnToUsdt(0, 1500), /amountNgn must be a positive number/);
  assert.throws(() => convertNgnToUsdt(1500, 0), /exchangeRate must be a positive number/);
});
