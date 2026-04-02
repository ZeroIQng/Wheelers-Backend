export const SOLANA_CLUSTERS = {
  mainnet: 'https://api.mainnet-beta.solana.com',
  devnet:  'https://api.devnet.solana.com',
} as const;

export type SolanaCluster = keyof typeof SOLANA_CLUSTERS;

// USDT SPL token mint address on Solana mainnet
export const SOLANA_USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';

export function getSolanaRpcUrl(): string {
  const url = process.env['SOLANA_RPC_URL'];
  if (!url) throw new Error('[blockchain] SOLANA_RPC_URL is not set');
  return url;
}