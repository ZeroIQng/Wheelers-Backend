const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createRideEventsConsumer,
} = require('../apps/wallet-service/dist/consumers/ride-events.consumer.js');
const {
  createPaymentEventsConsumer,
} = require('../apps/wallet-service/dist/consumers/payment-events.consumer.js');
const {
  createDefiEventsConsumer,
} = require('../apps/wallet-service/dist/consumers/defi-events.consumer.js');

const riderId = '11111111-1111-4111-8111-111111111111';
const driverId = '22222222-2222-4222-8222-222222222222';
const paymentId = '33333333-3333-4333-8333-333333333333';
const rideId = '44444444-4444-4444-8444-444444444444';
const walletId = '55555555-5555-4555-8555-555555555555';

const baseContext = {
  topic: 'test.topic',
  partition: 0,
  offset: '0',
  timestamp: new Date().toISOString(),
  headers: {},
};

test('ride consumer locks rider funds and emits WALLET_LOCKED', async () => {
  const wallet = buildWallet({ balanceUsdt: 19.5 });
  const publishCalls = [];

  const consumer = createRideEventsConsumer({
    walletRepository: {
      findByUserId: async (userId) => {
        assert.equal(userId, riderId);
        return wallet;
      },
      createRideHold: async (params) => {
        assert.deepEqual(params, {
          rideId,
          walletId,
          riderId,
          amountUsdt: 4.5,
        });
        return {
          wallet,
          holdAmountUsdt: 4.5,
          applied: true,
        };
      },
    },
    walletEventsProducer: {
      publishLocked: async (payload, options) => {
        publishCalls.push({ payload, options });
      },
    },
  });

  await consumer.handle({
    eventType: 'RIDE_DRIVER_ASSIGNED',
    rideId,
    riderId,
    driverId,
    driverWallet: '0xdriver',
    driverName: 'Retry Driver',
    driverRating: 5,
    vehiclePlate: 'TEST-456',
    vehicleModel: 'Retry Model',
    etaSeconds: 120,
    lockedFareUsdt: 4.5,
    timestamp: new Date().toISOString(),
  }, baseContext);

  assert.deepEqual(publishCalls, [{
    payload: {
      walletId,
      userId: riderId,
      walletAddress: wallet.address,
      lockedAmountUsdt: 4.5,
      rideId,
      reason: 'ride_fare_hold',
    },
    options: { key: rideId },
  }]);
});

test('ride consumer skips duplicate ride holds without emitting an event', async () => {
  const publishCalls = [];

  const consumer = createRideEventsConsumer({
    walletRepository: {
      findByUserId: async () => buildWallet(),
      createRideHold: async () => ({
        wallet: buildWallet(),
        holdAmountUsdt: 4.5,
        applied: false,
      }),
    },
    walletEventsProducer: {
      publishLocked: async (payload) => {
        publishCalls.push(payload);
      },
    },
  });

  await consumer.handle({
    eventType: 'RIDE_DRIVER_ASSIGNED',
    rideId,
    riderId,
    driverId,
    driverWallet: '0xdriver',
    driverName: 'Retry Driver',
    driverRating: 5,
    vehiclePlate: 'TEST-456',
    vehicleModel: 'Retry Model',
    etaSeconds: 120,
    lockedFareUsdt: 4.5,
    timestamp: new Date().toISOString(),
  }, baseContext);

  assert.equal(publishCalls.length, 0);
});

test('payment consumer credits an onramp settlement and emits WALLET_CREDITED', async () => {
  const initialWallet = buildWallet({ balanceUsdt: 15 });
  const creditedWallet = buildWallet({ balanceUsdt: 22 });
  const publishCalls = [];

  const consumer = createPaymentEventsConsumer({
    walletRepository: {
      findByAddress: async (address) => {
        assert.equal(address, initialWallet.address.toUpperCase());
        return initialWallet;
      },
      credit: async (params) => {
        assert.equal(params.walletId, walletId);
        assert.equal(params.amountUsdt, 7);
        assert.equal(params.referenceId, 'pouch-session-1');
        return {
          wallet: creditedWallet,
          transaction: {},
          applied: true,
        };
      },
    },
    walletEventsProducer: {
      publishCredited: async (payload, options) => {
        publishCalls.push({ payload, options });
      },
    },
  });

  await consumer.handle({
    eventType: 'ONRAMP_SETTLED',
    paymentId,
    userId: riderId,
    paymentProvider: 'pouch',
    providerReference: 'pouch-session-1',
    amountUsd: 7,
    localCurrency: 'NGN',
    amountLocal: 10850,
    amountUsdt: 7,
    cryptoCurrency: 'USDT',
    cryptoNetwork: 'ERC20',
    userWallet: initialWallet.address.toUpperCase(),
    settlementReference: 'settle-1',
    timestamp: new Date().toISOString(),
  }, baseContext);

  assert.deepEqual(publishCalls, [{
    payload: {
      walletId,
      userId: riderId,
      walletAddress: initialWallet.address,
      amountUsdt: 7,
      newBalanceUsdt: 22,
      creditType: 'fiat_onramp',
      referenceId: 'pouch-session-1',
    },
    options: { key: riderId },
  }]);
});

test('defi consumer stakes idle funds for opted-in users', async () => {
  const wallet = buildWallet({ balanceUsdt: 11.75 });
  const publishCalls = [];
  const moveCalls = [];

  const consumer = createDefiEventsConsumer({
    walletRepository: {
      findByAddress: async (address) => {
        assert.equal(address, wallet.address.toUpperCase());
        return wallet;
      },
      moveToStaked: async (receivedWalletId, amountUsdt) => {
        moveCalls.push({ receivedWalletId, amountUsdt });
        return buildWallet({ balanceUsdt: 3.75, stakedUsdt: 8 });
      },
    },
    defiEventsProducer: {
      publishStaked: async (payload, options) => {
        publishCalls.push({ payload, options });
      },
    },
  });

  await consumer.handle({
    eventType: 'IDLE_FUNDS_DETECTED',
    userId: riderId,
    walletAddress: wallet.address.toUpperCase(),
    idleBalanceUsdt: 8,
    idleSinceHours: 24,
    recommendedTier: 'tier2',
    userOptedIn: true,
    timestamp: new Date().toISOString(),
  }, baseContext);

  assert.deepEqual(moveCalls, [{
    receivedWalletId: walletId,
    amountUsdt: 8,
  }]);
  assert.equal(publishCalls.length, 1);
  assert.equal(publishCalls[0].payload.userId, riderId);
  assert.equal(publishCalls[0].payload.walletAddress, wallet.address);
  assert.equal(publishCalls[0].payload.amountUsdt, 8);
  assert.equal(publishCalls[0].payload.protocol, 'aave');
  assert.equal(publishCalls[0].payload.tier, 'tier2');
  assert.equal(publishCalls[0].options.key, walletId);
});

function buildWallet(overrides = {}) {
  return {
    id: walletId,
    userId: riderId,
    address: '0xabcdef1234567890abcdef1234567890abcdef12',
    chain: 'base',
    balanceUsdt: 25,
    lockedUsdt: 0,
    stakedUsdt: 0,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}
