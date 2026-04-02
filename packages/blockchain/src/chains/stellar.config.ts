// Stellar uses USDC not USDT — this is the canonical USDC issuer on Stellar mainnet
export const STELLAR_USDC_ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
export const STELLAR_USDC_CODE   = 'USDC';

export const STELLAR_NETWORKS = {
  mainnet: {
    horizonUrl:   'https://horizon.stellar.org',
    sorobanRpcUrl: 'https://soroban-rpc.mainnet.stellar.gateway.fm',
    networkPassphrase: 'Public Global Stellar Network ; September 2015',
  },
  testnet: {
    horizonUrl:   'https://horizon-testnet.stellar.org',
    sorobanRpcUrl: 'https://soroban-testnet.stellar.org',
    networkPassphrase: 'Test SDF Network ; September 2015',
  },
} as const;

export type StellarNetwork = keyof typeof STELLAR_NETWORKS;

export function getStellarConfig(network: StellarNetwork = 'mainnet') {
  return STELLAR_NETWORKS[network];
}