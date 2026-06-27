import { z } from 'zod';

const BaseCryptoWalletEvent = z.object({
  userId:    z.string().uuid(),
  timestamp: z.string().datetime(),
});

// Fired by api-gateway when user requests crypto wallet creation.
// Consumed by: wallet-service (creates wallet, derives addresses).
export const CryptoWalletCreateRequestedEvent = BaseCryptoWalletEvent.extend({
  eventType: z.literal('CRYPTO_WALLET_CREATE_REQUESTED'),
  password:  z.string(),
});

// Fired by wallet-service after wallet is created.
// Consumed by: api-gateway (return addresses to user).
export const CryptoWalletCreatedEvent = BaseCryptoWalletEvent.extend({
  eventType:         z.literal('CRYPTO_WALLET_CREATED'),
  encryptedMnemonic: z.string(),
  encryptionSalt:    z.string(),
  addresses: z.array(z.object({
    chainId:   z.union([z.string(), z.number()]),
    chainName: z.string(),
    vmType:    z.enum(['EVM', 'SVM']),
    address:   z.string(),
  })),
});

// Fired by api-gateway when user requests deposit addresses.
// Consumed by: wallet-service (derives and returns addresses).
export const CryptoDepositRequestedEvent = BaseCryptoWalletEvent.extend({
  eventType:         z.literal('CRYPTO_DEPOSIT_REQUESTED'),
  encryptedMnemonic: z.string(),
  encryptionSalt:    z.string(),
  password:          z.string(),
  chainId:           z.union([z.string(), z.number()]).optional(),
});

// Fired by wallet-service with deposit address info.
// Consumed by: api-gateway (show deposit addresses to user).
export const CryptoDepositAddressEvent = BaseCryptoWalletEvent.extend({
  eventType: z.literal('CRYPTO_DEPOSIT_ADDRESS'),
  deposits: z.array(z.object({
    chainId:     z.union([z.string(), z.number()]),
    chainName:   z.string(),
    vmType:      z.enum(['EVM', 'SVM']),
    address:     z.string(),
    nativeToken: z.object({
      name:     z.string(),
      symbol:   z.string(),
      decimals: z.number(),
    }),
  })),
});

// Fired by api-gateway when user requests a crypto withdrawal.
// Consumed by: wallet-service (executes on-chain transfer).
export const CryptoWithdrawRequestedEvent = BaseCryptoWalletEvent.extend({
  eventType:         z.literal('CRYPTO_WITHDRAW_REQUESTED'),
  encryptedMnemonic: z.string(),
  encryptionSalt:    z.string(),
  password:          z.string(),
  chainId:           z.union([z.string(), z.number()]),
  toAddress:         z.string(),
  amount:            z.number(),
  token: z.object({
    address:  z.string(),
    name:     z.string(),
    symbol:   z.string(),
    decimals: z.number(),
  }).optional(),
});

// Fired by wallet-service after withdrawal is executed.
// Consumed by: api-gateway (notify user of result).
export const CryptoWithdrawCompletedEvent = BaseCryptoWalletEvent.extend({
  eventType: z.literal('CRYPTO_WITHDRAW_COMPLETED'),
  chainId:   z.union([z.string(), z.number()]),
  chainName: z.string(),
  txHash:    z.string(),
  success:   z.boolean(),
  error:     z.string().optional(),
  amount:    z.number(),
  toAddress: z.string(),
});

// Fired by api-gateway when user requests balance check.
// Consumed by: wallet-service (queries on-chain balance).
export const CryptoBalanceRequestedEvent = BaseCryptoWalletEvent.extend({
  eventType:         z.literal('CRYPTO_BALANCE_REQUESTED'),
  encryptedMnemonic: z.string(),
  encryptionSalt:    z.string(),
  password:          z.string(),
  chainId:           z.union([z.string(), z.number()]).optional(),
});

// Fired by wallet-service with balance result.
// Consumed by: api-gateway (show balance to user).
export const CryptoBalanceResultEvent = BaseCryptoWalletEvent.extend({
  eventType: z.literal('CRYPTO_BALANCE_RESULT'),
  balances: z.array(z.object({
    chainId:   z.union([z.string(), z.number()]),
    chainName: z.string(),
    balance:   z.number(),
    decimals:  z.number(),
  })),
});

export const CryptoWalletEvent = z.discriminatedUnion('eventType', [
  CryptoWalletCreateRequestedEvent,
  CryptoWalletCreatedEvent,
  CryptoDepositRequestedEvent,
  CryptoDepositAddressEvent,
  CryptoWithdrawRequestedEvent,
  CryptoWithdrawCompletedEvent,
  CryptoBalanceRequestedEvent,
  CryptoBalanceResultEvent,
]);

export type CryptoWalletCreateRequestedEvent = z.infer<typeof CryptoWalletCreateRequestedEvent>;
export type CryptoWalletCreatedEvent         = z.infer<typeof CryptoWalletCreatedEvent>;
export type CryptoDepositRequestedEvent      = z.infer<typeof CryptoDepositRequestedEvent>;
export type CryptoDepositAddressEvent        = z.infer<typeof CryptoDepositAddressEvent>;
export type CryptoWithdrawRequestedEvent     = z.infer<typeof CryptoWithdrawRequestedEvent>;
export type CryptoWithdrawCompletedEvent     = z.infer<typeof CryptoWithdrawCompletedEvent>;
export type CryptoBalanceRequestedEvent      = z.infer<typeof CryptoBalanceRequestedEvent>;
export type CryptoBalanceResultEvent         = z.infer<typeof CryptoBalanceResultEvent>;
export type CryptoWalletEvent               = z.infer<typeof CryptoWalletEvent>;
