const test = require('node:test');
const assert = require('node:assert/strict');

const {
  MultiChainWalletService,
  GenerateNewMnemonic,
  ValidateMnemonic,
  GenerateSeed,
  VM,
  EVMVM,
  SVMVM,
  EVMChainWallet,
  SVMChainWallet,
  DefaultChains,
} = require('../packages/multi-chain-wallet/dist/index.js');

// ── Test constants ─────────────────────────────────────────────────────

const TEST_PASSWORD = 'super-secret-password-123!';

// Known mnemonic for deterministic tests (DO NOT use in production)
const TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

const TEST_CHAINS = [
  {
    chainId: 1,
    name: 'Ethereum Mainnet',
    rpcUrl: 'https://eth-mainnet.g.alchemy.com/v2/demo',
    explorerUrl: 'https://etherscan.io',
    nativeToken: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    vmType: 'EVM',
  },
  {
    chainId: 56,
    name: 'BNB Smart Chain',
    rpcUrl: 'https://bsc-dataseed.binance.org/',
    explorerUrl: 'https://bscscan.com',
    nativeToken: { name: 'BNB', symbol: 'BNB', decimals: 18 },
    vmType: 'EVM',
  },
  {
    chainId: 501,
    name: 'Solana Mainnet',
    rpcUrl: 'https://api.mainnet-beta.solana.com',
    explorerUrl: 'https://explorer.solana.com',
    nativeToken: { name: 'Solana', symbol: 'SOL', decimals: 9 },
    vmType: 'SVM',
  },
];

// ═══════════════════════════════════════════════════════════════════════
// 1. Mnemonic & BIP32 fundamentals
// ═══════════════════════════════════════════════════════════════════════

test('GenerateNewMnemonic produces a valid 12-word mnemonic', () => {
  const mnemonic = GenerateNewMnemonic();
  const words = mnemonic.split(' ');
  assert.equal(words.length, 12, 'mnemonic should be 12 words');

  // Should not throw
  ValidateMnemonic(mnemonic);
});

test('ValidateMnemonic throws on invalid mnemonic', () => {
  assert.throws(
    () => ValidateMnemonic('not a valid mnemonic phrase at all hello world foo bar'),
    /Invalid mnemonic/,
  );
});

test('GenerateSeed produces a deterministic seed from mnemonic', () => {
  const seed1 = GenerateSeed(TEST_MNEMONIC);
  const seed2 = GenerateSeed(TEST_MNEMONIC);

  // Same mnemonic → same seed
  assert.deepEqual(seed1, seed2);
});

test('GenerateSeed without mnemonic creates a new random seed each time', () => {
  const seed1 = GenerateSeed();
  const seed2 = GenerateSeed();

  // Different calls → different seeds (overwhelmingly likely)
  assert.notDeepEqual(seed1, seed2);
});

// ═══════════════════════════════════════════════════════════════════════
// 2. Encryption / Decryption (Security layer)
// ═══════════════════════════════════════════════════════════════════════

test('encryptSeedPhrase + decryptSeedPhrase round-trips correctly', () => {
  const { encrypted, salt } = VM.encryptSeedPhrase(TEST_MNEMONIC, TEST_PASSWORD);

  // Encrypted output should NOT be the raw mnemonic
  assert.notEqual(encrypted, TEST_MNEMONIC);
  assert.ok(encrypted.length > 0, 'encrypted should not be empty');
  assert.ok(salt.length > 0, 'salt should not be empty');

  // Decrypt with correct password → get original mnemonic back
  const decrypted = VM.decryptSeedPhrase(encrypted, TEST_PASSWORD, salt);
  assert.equal(decrypted, TEST_MNEMONIC);
});

test('decryptSeedPhrase returns null with wrong password', () => {
  const { encrypted, salt } = VM.encryptSeedPhrase(TEST_MNEMONIC, TEST_PASSWORD);

  const decrypted = VM.decryptSeedPhrase(encrypted, 'wrong-password', salt);
  assert.equal(decrypted, null, 'wrong password should return null');
});

test('decryptSeedPhrase returns null with wrong salt', () => {
  const { encrypted } = VM.encryptSeedPhrase(TEST_MNEMONIC, TEST_PASSWORD);

  const decrypted = VM.decryptSeedPhrase(encrypted, TEST_PASSWORD, 'deadbeef');
  assert.equal(decrypted, null, 'wrong salt should return null');
});

test('each encryption produces a different ciphertext (unique salt)', () => {
  const result1 = VM.encryptSeedPhrase(TEST_MNEMONIC, TEST_PASSWORD);
  const result2 = VM.encryptSeedPhrase(TEST_MNEMONIC, TEST_PASSWORD);

  // Different salts → different ciphertext, even with same input
  assert.notEqual(result1.salt, result2.salt);
  assert.notEqual(result1.encrypted, result2.encrypted);
});

// ═══════════════════════════════════════════════════════════════════════
// 3. EVM key derivation & address generation
// ═══════════════════════════════════════════════════════════════════════

test('EVMVM derives deterministic private keys from same seed', () => {
  const seed = VM.mnemonicToSeed(TEST_MNEMONIC);
  const vm1 = new EVMVM(seed);
  const vm2 = new EVMVM(seed);

  const key1 = vm1.generatePrivateKey(0);
  const key2 = vm2.generatePrivateKey(0);

  assert.equal(key1.privateKey, key2.privateKey);
  assert.equal(key1.index, 0);
});

test('EVMVM derives different keys for different indices', () => {
  const seed = VM.mnemonicToSeed(TEST_MNEMONIC);
  const vm = new EVMVM(seed);

  const key0 = vm.generatePrivateKey(0);
  const key1 = vm.generatePrivateKey(1);

  assert.notEqual(key0.privateKey, key1.privateKey);
});

test('EVMChainWallet generates a valid Ethereum address (0x, 42 chars)', () => {
  const seed = VM.mnemonicToSeed(TEST_MNEMONIC);
  const vm = new EVMVM(seed);
  const { privateKey } = vm.generatePrivateKey(0);

  const wallet = new EVMChainWallet(TEST_CHAINS[0], `0x${privateKey}`, 0);
  const address = wallet.getAddress();

  assert.ok(address.startsWith('0x'), 'EVM address should start with 0x');
  assert.equal(address.length, 42, 'EVM address should be 42 chars');
  assert.ok(EVMVM.validateAddress(address), 'address should be valid');
});

test('EVMVM.validateAddress rejects invalid addresses', () => {
  assert.equal(EVMVM.validateAddress('0xinvalid'), false);
  assert.equal(EVMVM.validateAddress('not-an-address'), false);
  assert.equal(EVMVM.validateAddress(''), false);
});

// ═══════════════════════════════════════════════════════════════════════
// 4. SVM (Solana) key derivation & address generation
// ═══════════════════════════════════════════════════════════════════════

test('SVMVM derives deterministic keypairs from same seed', () => {
  const seed = VM.mnemonicToSeed(TEST_MNEMONIC);
  const vm1 = new SVMVM(seed);
  const vm2 = new SVMVM(seed);

  const key1 = vm1.generatePrivateKey(0);
  const key2 = vm2.generatePrivateKey(0);

  // Keypair publicKey should match
  assert.equal(
    key1.privateKey.publicKey.toBase58(),
    key2.privateKey.publicKey.toBase58(),
  );
});

test('SVMVM derives different keypairs for different indices', () => {
  const seed = VM.mnemonicToSeed(TEST_MNEMONIC);
  const vm = new SVMVM(seed);

  const key0 = vm.generatePrivateKey(0);
  const key1 = vm.generatePrivateKey(1);

  assert.notEqual(
    key0.privateKey.publicKey.toBase58(),
    key1.privateKey.publicKey.toBase58(),
  );
});

test('SVMChainWallet generates a valid Solana address (base58)', () => {
  const seed = VM.mnemonicToSeed(TEST_MNEMONIC);
  const vm = new SVMVM(seed);
  const { privateKey } = vm.generatePrivateKey(0);

  const wallet = new SVMChainWallet(TEST_CHAINS[2], privateKey, 0);
  const address = wallet.getAddress();

  // Solana addresses are base58-encoded public keys, typically 32-44 chars
  const base58Str = address.toBase58();
  assert.ok(base58Str.length >= 32, 'Solana address should be at least 32 chars');
  assert.ok(base58Str.length <= 44, 'Solana address should be at most 44 chars');
});

// ═══════════════════════════════════════════════════════════════════════
// 5. MultiChainWalletService — createWallet
// ═══════════════════════════════════════════════════════════════════════

test('createWallet returns mnemonic, encrypted mnemonic, salt, and addresses', () => {
  const service = new MultiChainWalletService(TEST_CHAINS);
  const wallet = service.createWallet(TEST_PASSWORD);

  // Has a 12-word mnemonic
  assert.equal(wallet.mnemonic.split(' ').length, 12);

  // Has encrypted mnemonic and salt
  assert.ok(wallet.encryptedMnemonic.length > 0);
  assert.ok(wallet.encryptionSalt.length > 0);

  // Encrypted is NOT the raw mnemonic
  assert.notEqual(wallet.encryptedMnemonic, wallet.mnemonic);

  // Has addresses for all 3 test chains
  assert.equal(wallet.addresses.length, 3);

  // Check each address type
  const evmAddresses = wallet.addresses.filter((a) => a.vmType === 'EVM');
  const svmAddresses = wallet.addresses.filter((a) => a.vmType === 'SVM');
  assert.equal(evmAddresses.length, 2); // ETH + BSC
  assert.equal(svmAddresses.length, 1); // SOL

  // EVM addresses should be 0x-prefixed
  for (const addr of evmAddresses) {
    assert.ok(addr.address.startsWith('0x'));
    assert.equal(addr.address.length, 42);
  }

  // All EVM wallets share the same address (same derivation path)
  assert.equal(evmAddresses[0].address, evmAddresses[1].address);
});

test('createWallet produces different wallets each call', () => {
  const service = new MultiChainWalletService(TEST_CHAINS);
  const wallet1 = service.createWallet(TEST_PASSWORD);
  const wallet2 = service.createWallet(TEST_PASSWORD);

  assert.notEqual(wallet1.mnemonic, wallet2.mnemonic);
  assert.notEqual(wallet1.addresses[0].address, wallet2.addresses[0].address);
});

// ═══════════════════════════════════════════════════════════════════════
// 6. MultiChainWalletService — importWallet
// ═══════════════════════════════════════════════════════════════════════

test('importWallet derives the same addresses as the original mnemonic', () => {
  const service = new MultiChainWalletService(TEST_CHAINS);

  const wallet1 = service.importWallet(TEST_MNEMONIC, TEST_PASSWORD);
  const wallet2 = service.importWallet(TEST_MNEMONIC, 'different-password');

  // Same mnemonic → same addresses regardless of encryption password
  assert.equal(wallet1.addresses.length, wallet2.addresses.length);
  for (let i = 0; i < wallet1.addresses.length; i++) {
    assert.equal(wallet1.addresses[i].address, wallet2.addresses[i].address);
    assert.equal(wallet1.addresses[i].chainId, wallet2.addresses[i].chainId);
  }
});

test('importWallet throws on invalid mnemonic', () => {
  const service = new MultiChainWalletService(TEST_CHAINS);

  assert.throws(
    () => service.importWallet('invalid mnemonic words here not twelve', TEST_PASSWORD),
    /Invalid mnemonic/,
  );
});

// ═══════════════════════════════════════════════════════════════════════
// 7. MultiChainWalletService — recoverWallet
// ═══════════════════════════════════════════════════════════════════════

test('recoverWallet decrypts and recovers the same addresses', () => {
  const service = new MultiChainWalletService(TEST_CHAINS);
  const original = service.createWallet(TEST_PASSWORD);

  const recovered = service.recoverWallet(
    original.encryptedMnemonic,
    TEST_PASSWORD,
    original.encryptionSalt,
  );

  assert.ok(recovered !== null, 'recovery should succeed');
  assert.equal(recovered.mnemonic, original.mnemonic);

  // Addresses should match
  for (let i = 0; i < original.addresses.length; i++) {
    assert.equal(recovered.addresses[i].address, original.addresses[i].address);
  }
});

test('recoverWallet returns null with wrong password', () => {
  const service = new MultiChainWalletService(TEST_CHAINS);
  const original = service.createWallet(TEST_PASSWORD);

  const recovered = service.recoverWallet(
    original.encryptedMnemonic,
    'wrong-password',
    original.encryptionSalt,
  );

  assert.equal(recovered, null);
});

test('recoverWallet returns null with wrong salt', () => {
  const service = new MultiChainWalletService(TEST_CHAINS);
  const original = service.createWallet(TEST_PASSWORD);

  const recovered = service.recoverWallet(
    original.encryptedMnemonic,
    TEST_PASSWORD,
    'deadbeefdeadbeef',
  );

  assert.equal(recovered, null);
});

// ═══════════════════════════════════════════════════════════════════════
// 8. MultiChainWalletService — getDepositAddresses
// ═══════════════════════════════════════════════════════════════════════

test('getDepositAddresses returns deposit info for all chains', () => {
  const service = new MultiChainWalletService(TEST_CHAINS);
  const deposits = service.getDepositAddresses(TEST_MNEMONIC);

  assert.equal(deposits.length, 3);

  for (const deposit of deposits) {
    assert.ok(deposit.chainId, 'should have chainId');
    assert.ok(deposit.chainName, 'should have chainName');
    assert.ok(deposit.address, 'should have address');
    assert.ok(deposit.vmType, 'should have vmType');
    assert.ok(deposit.nativeToken, 'should have nativeToken');
    assert.ok(deposit.nativeToken.symbol, 'should have token symbol');
    assert.ok(deposit.nativeToken.decimals >= 0, 'should have decimals');
  }
});

test('getDepositAddress returns deposit for a specific chain', () => {
  const service = new MultiChainWalletService(TEST_CHAINS);

  const ethDeposit = service.getDepositAddress(TEST_MNEMONIC, 1);
  assert.ok(ethDeposit !== null);
  assert.equal(ethDeposit.chainId, 1);
  assert.equal(ethDeposit.vmType, 'EVM');
  assert.equal(ethDeposit.nativeToken.symbol, 'ETH');

  const solDeposit = service.getDepositAddress(TEST_MNEMONIC, 501);
  assert.ok(solDeposit !== null);
  assert.equal(solDeposit.chainId, 501);
  assert.equal(solDeposit.vmType, 'SVM');
  assert.equal(solDeposit.nativeToken.symbol, 'SOL');
});

test('getDepositAddress returns null for unconfigured chain', () => {
  const service = new MultiChainWalletService(TEST_CHAINS);
  const deposit = service.getDepositAddress(TEST_MNEMONIC, 99999);
  assert.equal(deposit, null);
});

test('same mnemonic always produces the same deposit addresses', () => {
  const service = new MultiChainWalletService(TEST_CHAINS);

  const deposits1 = service.getDepositAddresses(TEST_MNEMONIC);
  const deposits2 = service.getDepositAddresses(TEST_MNEMONIC);

  for (let i = 0; i < deposits1.length; i++) {
    assert.equal(deposits1[i].address, deposits2[i].address);
  }
});

// ═══════════════════════════════════════════════════════════════════════
// 9. MultiChainWalletService — withdraw (error cases only, no real txs)
// ═══════════════════════════════════════════════════════════════════════

test('withdraw throws for unconfigured chain', async () => {
  const service = new MultiChainWalletService(TEST_CHAINS);

  await assert.rejects(
    () => service.withdraw(TEST_MNEMONIC, {
      chainId: 99999,
      toAddress: '0x0000000000000000000000000000000000000001',
      amount: 0.01,
    }),
    /Chain 99999 not configured/,
  );
});

// ═══════════════════════════════════════════════════════════════════════
// 10. DefaultChains configuration
// ═══════════════════════════════════════════════════════════════════════

test('DefaultChains contains expected chains', () => {
  assert.ok(DefaultChains.length >= 4, 'should have at least 4 default chains');

  const chainIds = DefaultChains.map((c) => c.chainId);
  assert.ok(chainIds.includes(1), 'should include Ethereum (1)');
  assert.ok(chainIds.includes(56), 'should include BSC (56)');
  assert.ok(chainIds.includes(501), 'should include Solana (501)');

  for (const chain of DefaultChains) {
    assert.ok(chain.rpcUrl, `chain ${chain.name} should have rpcUrl`);
    assert.ok(chain.vmType === 'EVM' || chain.vmType === 'SVM', `chain ${chain.name} should have valid vmType`);
    assert.ok(chain.nativeToken.symbol, `chain ${chain.name} should have token symbol`);
  }
});

// ═══════════════════════════════════════════════════════════════════════
// 11. Security properties
// ═══════════════════════════════════════════════════════════════════════

test('private keys are never exposed in CryptoWallet output', () => {
  const service = new MultiChainWalletService(TEST_CHAINS);
  const wallet = service.createWallet(TEST_PASSWORD);

  // The wallet object should NOT contain raw private keys
  const walletJson = JSON.stringify(wallet);
  assert.ok(!walletJson.includes('privateKey'), 'wallet output must not contain privateKey');

  // Addresses are public, so they should be present
  for (const addr of wallet.addresses) {
    assert.ok(walletJson.includes(addr.address), 'addresses should be in output');
  }
});

test('mnemonic is not stored in encrypted mnemonic field', () => {
  const service = new MultiChainWalletService(TEST_CHAINS);
  const wallet = service.createWallet(TEST_PASSWORD);

  assert.ok(
    !wallet.encryptedMnemonic.includes(wallet.mnemonic),
    'encrypted field must not contain raw mnemonic',
  );
});

test('encryption salt is not the password', () => {
  const service = new MultiChainWalletService(TEST_CHAINS);
  const wallet = service.createWallet(TEST_PASSWORD);

  assert.notEqual(wallet.encryptionSalt, TEST_PASSWORD);
});

test('PBKDF2 key derivation produces different keys for different salts', () => {
  const salt1 = VM.generateSalt();
  const salt2 = VM.generateSalt();
  const key1 = VM.deriveKey(TEST_PASSWORD, salt1);
  const key2 = VM.deriveKey(TEST_PASSWORD, salt2);
  assert.notEqual(key1, key2);
});

test('PBKDF2 key derivation produces different keys for different passwords', () => {
  const salt = VM.generateSalt();
  const key1 = VM.deriveKey('password1', salt);
  const key2 = VM.deriveKey('password2', salt);
  assert.notEqual(key1, key2);
});

// ═══════════════════════════════════════════════════════════════════════
// 12. End-to-end flow: create → encrypt → recover → deposit
// ═══════════════════════════════════════════════════════════════════════

test('full flow: create wallet → recover → get same deposit addresses', () => {
  const service = new MultiChainWalletService(TEST_CHAINS);

  // Step 1: Create wallet
  const created = service.createWallet(TEST_PASSWORD);

  // Step 2: Simulate storing only encrypted mnemonic + salt (DB)
  const stored = {
    encryptedMnemonic: created.encryptedMnemonic,
    encryptionSalt: created.encryptionSalt,
  };

  // Step 3: Recover from stored data
  const recovered = service.recoverWallet(
    stored.encryptedMnemonic,
    TEST_PASSWORD,
    stored.encryptionSalt,
  );
  assert.ok(recovered !== null);

  // Step 4: Get deposit addresses from recovered wallet
  const deposits = service.getDepositAddresses(recovered.mnemonic);

  // Step 5: Verify addresses match the original
  assert.equal(deposits.length, created.addresses.length);
  for (let i = 0; i < deposits.length; i++) {
    assert.equal(deposits[i].address, created.addresses[i].address);
  }
});

// ═══════════════════════════════════════════════════════════════════════
// 13. Crypto wallet events consumer (unit tests with mocks)
// ═══════════════════════════════════════════════════════════════════════

const {
  createCryptoWalletEventsConsumer,
} = require('../apps/wallet-service/dist/consumers/crypto-wallet-events.consumer.js');

const userId = '11111111-1111-4111-8111-111111111111';

const baseContext = {
  topic: 'crypto-wallet.events',
  partition: 0,
  offset: '0',
  timestamp: new Date().toISOString(),
  headers: {},
};

test('crypto consumer creates wallet and publishes CRYPTO_WALLET_CREATED', async () => {
  const publishCalls = [];

  const consumer = createCryptoWalletEventsConsumer({
    cryptoWalletEventsProducer: {
      publishWalletCreated: async (payload, options) => {
        publishCalls.push({ payload, options });
      },
    },
  });

  await consumer.handle({
    eventType: 'CRYPTO_WALLET_CREATE_REQUESTED',
    userId,
    password: TEST_PASSWORD,
    timestamp: new Date().toISOString(),
  }, baseContext);

  assert.equal(publishCalls.length, 1, 'should publish exactly one event');

  const { payload, options } = publishCalls[0];
  assert.equal(payload.userId, userId);
  assert.equal(options.key, userId);
  assert.ok(payload.encryptedMnemonic.length > 0, 'should have encrypted mnemonic');
  assert.ok(payload.encryptionSalt.length > 0, 'should have salt');
  assert.ok(payload.addresses.length > 0, 'should have addresses');

  // Verify addresses have correct shape
  for (const addr of payload.addresses) {
    assert.ok(addr.chainId, 'address should have chainId');
    assert.ok(addr.chainName, 'address should have chainName');
    assert.ok(addr.vmType === 'EVM' || addr.vmType === 'SVM', 'address should have valid vmType');
    assert.ok(addr.address.length > 0, 'address should not be empty');
  }
});

test('crypto consumer returns deposit addresses for CRYPTO_DEPOSIT_REQUESTED', async () => {
  // First create a wallet to get encrypted mnemonic
  const service = new MultiChainWalletService();
  const wallet = service.createWallet(TEST_PASSWORD);

  const publishCalls = [];

  const consumer = createCryptoWalletEventsConsumer({
    cryptoWalletEventsProducer: {
      publishDepositAddress: async (payload, options) => {
        publishCalls.push({ payload, options });
      },
    },
  });

  await consumer.handle({
    eventType: 'CRYPTO_DEPOSIT_REQUESTED',
    userId,
    encryptedMnemonic: wallet.encryptedMnemonic,
    encryptionSalt: wallet.encryptionSalt,
    password: TEST_PASSWORD,
    timestamp: new Date().toISOString(),
  }, baseContext);

  assert.equal(publishCalls.length, 1);

  const { payload } = publishCalls[0];
  assert.equal(payload.userId, userId);
  assert.ok(payload.deposits.length > 0, 'should return deposit addresses');

  for (const deposit of payload.deposits) {
    assert.ok(deposit.chainId, 'deposit should have chainId');
    assert.ok(deposit.address, 'deposit should have address');
    assert.ok(deposit.nativeToken, 'deposit should have nativeToken info');
    assert.ok(deposit.nativeToken.symbol, 'deposit should have token symbol');
  }
});

test('crypto consumer handles wrong password gracefully for deposit', async () => {
  const service = new MultiChainWalletService();
  const wallet = service.createWallet(TEST_PASSWORD);

  const publishCalls = [];

  const consumer = createCryptoWalletEventsConsumer({
    cryptoWalletEventsProducer: {
      publishDepositAddress: async (payload, options) => {
        publishCalls.push({ payload, options });
      },
    },
  });

  await consumer.handle({
    eventType: 'CRYPTO_DEPOSIT_REQUESTED',
    userId,
    encryptedMnemonic: wallet.encryptedMnemonic,
    encryptionSalt: wallet.encryptionSalt,
    password: 'wrong-password',
    timestamp: new Date().toISOString(),
  }, baseContext);

  // Should NOT publish anything (decryption failed)
  assert.equal(publishCalls.length, 0, 'should not publish on failed decryption');
});

test('crypto consumer publishes failure for withdraw with wrong password', async () => {
  const service = new MultiChainWalletService();
  const wallet = service.createWallet(TEST_PASSWORD);

  const publishCalls = [];

  const consumer = createCryptoWalletEventsConsumer({
    cryptoWalletEventsProducer: {
      publishWithdrawCompleted: async (payload, options) => {
        publishCalls.push({ payload, options });
      },
    },
  });

  await consumer.handle({
    eventType: 'CRYPTO_WITHDRAW_REQUESTED',
    userId,
    encryptedMnemonic: wallet.encryptedMnemonic,
    encryptionSalt: wallet.encryptionSalt,
    password: 'wrong-password',
    chainId: 1,
    toAddress: '0x0000000000000000000000000000000000000001',
    amount: 0.01,
    timestamp: new Date().toISOString(),
  }, baseContext);

  assert.equal(publishCalls.length, 1);
  assert.equal(publishCalls[0].payload.success, false);
  assert.equal(publishCalls[0].payload.error, 'Failed to decrypt wallet');
});

test('crypto consumer ignores unknown event types without crashing', async () => {
  const consumer = createCryptoWalletEventsConsumer({
    cryptoWalletEventsProducer: {},
  });

  // Should not throw
  await consumer.handle({
    eventType: 'UNKNOWN_EVENT',
    userId,
    timestamp: new Date().toISOString(),
  }, baseContext);
});

// ═══════════════════════════════════════════════════════════════════════
// 14. Edge cases — input validation
// ═══════════════════════════════════════════════════════════════════════

test('createWallet throws on empty password', () => {
  const service = new MultiChainWalletService(TEST_CHAINS);
  assert.throws(() => service.createWallet(''), /Password is required/);
});

test('importWallet throws on empty mnemonic', () => {
  const service = new MultiChainWalletService(TEST_CHAINS);
  assert.throws(() => service.importWallet('', TEST_PASSWORD), /Mnemonic is required/);
  assert.throws(() => service.importWallet('   ', TEST_PASSWORD), /Mnemonic is required/);
});

test('importWallet throws on empty password', () => {
  const service = new MultiChainWalletService(TEST_CHAINS);
  assert.throws(
    () => service.importWallet(TEST_MNEMONIC, ''),
    /Password is required/,
  );
});

test('withdraw throws on empty toAddress', async () => {
  const service = new MultiChainWalletService(TEST_CHAINS);
  await assert.rejects(
    () => service.withdraw(TEST_MNEMONIC, { chainId: 1, toAddress: '', amount: 0.01 }),
    /toAddress is required/,
  );
  await assert.rejects(
    () => service.withdraw(TEST_MNEMONIC, { chainId: 1, toAddress: '   ', amount: 0.01 }),
    /toAddress is required/,
  );
});

test('withdraw throws on zero or negative amount', async () => {
  const service = new MultiChainWalletService(TEST_CHAINS);
  const validAddr = '0x0000000000000000000000000000000000000001';

  await assert.rejects(
    () => service.withdraw(TEST_MNEMONIC, { chainId: 1, toAddress: validAddr, amount: 0 }),
    /amount must be a positive finite number/,
  );
  await assert.rejects(
    () => service.withdraw(TEST_MNEMONIC, { chainId: 1, toAddress: validAddr, amount: -5 }),
    /amount must be a positive finite number/,
  );
});

test('withdraw throws on NaN or Infinity amount', async () => {
  const service = new MultiChainWalletService(TEST_CHAINS);
  const validAddr = '0x0000000000000000000000000000000000000001';

  await assert.rejects(
    () => service.withdraw(TEST_MNEMONIC, { chainId: 1, toAddress: validAddr, amount: NaN }),
    /amount must be a positive finite number/,
  );
  await assert.rejects(
    () => service.withdraw(TEST_MNEMONIC, { chainId: 1, toAddress: validAddr, amount: Infinity }),
    /amount must be a positive finite number/,
  );
});

test('withdraw throws on invalid EVM address', async () => {
  const service = new MultiChainWalletService(TEST_CHAINS);
  await assert.rejects(
    () => service.withdraw(TEST_MNEMONIC, { chainId: 1, toAddress: 'not-an-address', amount: 0.01 }),
    /Invalid EVM address/,
  );
});

test('withdraw throws on invalid Solana address for SVM chain', async () => {
  const service = new MultiChainWalletService(TEST_CHAINS);
  await assert.rejects(
    () => service.withdraw(TEST_MNEMONIC, { chainId: 501, toAddress: '0xinvalid', amount: 0.01 }),
    /Invalid Solana address/,
  );
});

// ═══════════════════════════════════════════════════════════════════════
// 15. Edge cases — negative derivation index
// ═══════════════════════════════════════════════════════════════════════

test('getDepositAddresses throws on negative index', () => {
  const service = new MultiChainWalletService(TEST_CHAINS);
  assert.throws(
    () => service.getDepositAddresses(TEST_MNEMONIC, -1),
    /Derivation index must be a non-negative integer/,
  );
});

test('getDepositAddresses throws on fractional index', () => {
  const service = new MultiChainWalletService(TEST_CHAINS);
  assert.throws(
    () => service.getDepositAddresses(TEST_MNEMONIC, 1.5),
    /Derivation index must be a non-negative integer/,
  );
});

// ═══════════════════════════════════════════════════════════════════════
// 16. Edge cases — chain with missing vmType
// ═══════════════════════════════════════════════════════════════════════

test('deriving addresses throws when chain has no vmType', () => {
  const badChains = [{
    chainId: 999,
    name: 'Bad Chain',
    rpcUrl: 'https://example.com',
    explorerUrl: 'https://example.com',
    nativeToken: { name: 'BAD', symbol: 'BAD', decimals: 18 },
    // vmType intentionally missing
  }];

  const service = new MultiChainWalletService(badChains);
  assert.throws(
    () => service.createWallet(TEST_PASSWORD),
    /missing vmType/,
  );
});

// ═══════════════════════════════════════════════════════════════════════
// 17. Edge cases — duplicate chainId disambiguation
// ═══════════════════════════════════════════════════════════════════════

test('getDepositAddress with chainName disambiguates duplicate chainIds', () => {
  // Solana and Eclipse both use chainId 501
  const dualChains = [
    {
      chainId: 501,
      name: 'Solana Mainnet',
      rpcUrl: 'https://api.mainnet-beta.solana.com',
      explorerUrl: 'https://explorer.solana.com',
      nativeToken: { name: 'Solana', symbol: 'SOL', decimals: 9 },
      vmType: 'SVM',
    },
    {
      chainId: 501,
      name: 'Eclipse Mainnet',
      rpcUrl: 'https://mainnetbeta-rpc.eclipse.xyz',
      explorerUrl: 'https://explorer.eclipse.xyz/',
      nativeToken: { name: 'Eclipse', symbol: 'ETH', decimals: 9 },
      vmType: 'SVM',
    },
  ];

  const service = new MultiChainWalletService(dualChains);

  // Without chainName, returns the first match (Solana)
  const first = service.getDepositAddress(TEST_MNEMONIC, 501);
  assert.equal(first.chainName, 'Solana Mainnet');

  // With chainName, returns the specific chain
  const eclipse = service.getDepositAddress(TEST_MNEMONIC, 501, 0, 'Eclipse Mainnet');
  assert.equal(eclipse.chainName, 'Eclipse Mainnet');

  const solana = service.getDepositAddress(TEST_MNEMONIC, 501, 0, 'Solana Mainnet');
  assert.equal(solana.chainName, 'Solana Mainnet');

  // Both are SVM with chainId 501 but different addresses are generated
  // (same derivation path so same address, but the chainName distinguishes them)
  assert.equal(eclipse.address, solana.address);  // Same key derivation
  assert.notEqual(eclipse.nativeToken.symbol, solana.nativeToken.symbol);
});

// ═══════════════════════════════════════════════════════════════════════
// 18. Edge cases — consumer gracefully handles withdraw crash
// ═══════════════════════════════════════════════════════════════════════

test('crypto consumer publishes failure when withdraw throws (e.g. bad address validation)', async () => {
  const service = new MultiChainWalletService();
  const wallet = service.createWallet(TEST_PASSWORD);

  const publishCalls = [];

  const consumer = createCryptoWalletEventsConsumer({
    cryptoWalletEventsProducer: {
      publishWithdrawCompleted: async (payload, options) => {
        publishCalls.push({ payload, options });
      },
    },
  });

  // Send a withdraw with an invalid EVM address — should publish failure, not crash
  await consumer.handle({
    eventType: 'CRYPTO_WITHDRAW_REQUESTED',
    userId,
    encryptedMnemonic: wallet.encryptedMnemonic,
    encryptionSalt: wallet.encryptionSalt,
    password: TEST_PASSWORD,
    chainId: 1,
    toAddress: 'totally-not-an-address',
    amount: 0.01,
    timestamp: new Date().toISOString(),
  }, baseContext);

  assert.equal(publishCalls.length, 1);
  assert.equal(publishCalls[0].payload.success, false);
  assert.ok(publishCalls[0].payload.error.length > 0, 'should have error message');
  assert.equal(publishCalls[0].payload.toAddress, 'totally-not-an-address');
});

test('crypto consumer publishes empty balances on decryption failure', async () => {
  const service = new MultiChainWalletService();
  const wallet = service.createWallet(TEST_PASSWORD);

  const publishCalls = [];

  const consumer = createCryptoWalletEventsConsumer({
    cryptoWalletEventsProducer: {
      publishBalanceResult: async (payload, options) => {
        publishCalls.push({ payload, options });
      },
    },
  });

  await consumer.handle({
    eventType: 'CRYPTO_BALANCE_REQUESTED',
    userId,
    encryptedMnemonic: wallet.encryptedMnemonic,
    encryptionSalt: wallet.encryptionSalt,
    password: 'wrong-password',
    timestamp: new Date().toISOString(),
  }, baseContext);

  assert.equal(publishCalls.length, 1);
  assert.deepEqual(publishCalls[0].payload.balances, []);
});
