import { base, polygon, mainnet, arbitrum } from 'viem/chains';

export const SUPPORTED_EVM_CHAINS = {
  base,
  polygon,
  mainnet,
  arbitrum,
} as const;

export type SupportedEvmChain = keyof typeof SUPPORTED_EVM_CHAINS;

export const DEFAULT_EVM_CHAIN: SupportedEvmChain = 'base';

// USDT contract addresses per chain — used by wallet-service to detect
// on-chain deposits and by compliance-worker to log on-chain receipts.
export const USDT_ADDRESSES: Record<SupportedEvmChain, `0x${string}`> = {
  base:     '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2',
  polygon:  '0xc2132D05D31c914a87C6611C10748AEb04B58e8F',
  mainnet:  '0xdAC17F958D2ee523a2206206994597C13D831ec7',
  arbitrum: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9',
};

// Returns the RPC URL for a chain from environment variables.
// Called by evm.client.ts when creating public/wallet clients.
export function getRpcUrl(chain: SupportedEvmChain): string {
  const key = `RPC_URL_${chain.toUpperCase()}`;
  const url = process.env[key];
  if (!url) throw new Error(`[blockchain] ${key} environment variable is not set`);
  return url;
}