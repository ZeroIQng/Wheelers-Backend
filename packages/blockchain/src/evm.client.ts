import { createPublicClient, createWalletClient, http } from 'viem';
import { privateKeyToAccount }                          from 'viem/accounts';
import {
  SUPPORTED_EVM_CHAINS,
  DEFAULT_EVM_CHAIN,
  getRpcUrl,
  type SupportedEvmChain,
} from '../src/chains/evm.config';

// Read-only client — used for checking balances, reading contract state,
// detecting incoming deposits. No private key needed.
export function getPublicClient(chain: SupportedEvmChain = DEFAULT_EVM_CHAIN) {
  return createPublicClient({
    chain:     SUPPORTED_EVM_CHAINS[chain],
    transport: http(getRpcUrl(chain)),
  });
}

// Signing client — used for sending transactions: settlement payouts,
// on-chain compliance logs, DeFi staking, consent recording.
// Uses the platform hot wallet private key from env.
export function getWalletClient(chain: SupportedEvmChain = DEFAULT_EVM_CHAIN) {
  const privateKey = process.env['PLATFORM_PRIVATE_KEY'] as `0x${string}`;
  if (!privateKey) {
    throw new Error('[blockchain] PLATFORM_PRIVATE_KEY is not set');
  }

  const account = privateKeyToAccount(privateKey);

  return createWalletClient({
    account,
    chain:     SUPPORTED_EVM_CHAINS[chain],
    transport: http(getRpcUrl(chain)),
  });
}

// Returns the platform wallet address without creating a full wallet client.
// Useful for displaying the address or checking if a deposit came from us.
export function getPlatformAddress(): `0x${string}` {
  const privateKey = process.env['PLATFORM_PRIVATE_KEY'] as `0x${string}`;
  if (!privateKey) {
    throw new Error('[blockchain] PLATFORM_PRIVATE_KEY is not set');
  }
  return privateKeyToAccount(privateKey).address;
}