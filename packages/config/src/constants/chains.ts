export const CHAINS = {
  BASE:     { id: 8453,  name: 'Base',     rpcEnvKey: 'RPC_URL_BASE'     },
  POLYGON:  { id: 137,   name: 'Polygon',  rpcEnvKey: 'RPC_URL_POLYGON'  },
  MAINNET:  { id: 1,     name: 'Ethereum', rpcEnvKey: 'RPC_URL_MAINNET'  },
  ARBITRUM: { id: 42161, name: 'Arbitrum', rpcEnvKey: 'RPC_URL_ARBITRUM' },
} as const;

export const DEFAULT_CHAIN = CHAINS.BASE;

// USDT contract addresses per EVM chain.
export const USDT_ADDRESSES: Record<number, `0x${string}`> = {
  [CHAINS.BASE.id]:     '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2',
  [CHAINS.POLYGON.id]:  '0xc2132D05D31c914a87C6611C10748AEb04B58e8F',
  [CHAINS.MAINNET.id]:  '0xdAC17F958D2ee523a2206206994597C13D831ec7',
  [CHAINS.ARBITRUM.id]: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9',
};

export const SUPPORTED_CHAIN_IDS = Object.values(CHAINS).map(c => c.id);