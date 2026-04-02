// Chain configs
export {
  SUPPORTED_EVM_CHAINS,
  DEFAULT_EVM_CHAIN,
  USDT_ADDRESSES,
  getRpcUrl,
  type SupportedEvmChain,
} from './chains/evm.config';

export {
  SOLANA_USDT_MINT,
  getSolanaRpcUrl,
} from './chains/solana.config';

export {
  STELLAR_USDC_ISSUER,
  STELLAR_USDC_CODE,
  getStellarConfig,
  type StellarNetwork,
} from './chains/stellar.config';

// EVM clients
export { getPublicClient, getWalletClient, getPlatformAddress } from '../src/evm.client';

// Solana client
export { getSolanaConnection, getPlatformKeypair } from './solana.client';

// Stellar client
export { getHorizonServer, getPlatformStellarKeypair } from './stellar.client';

// Contracts
export {
  logConsentOnChain,
  verifyConsentOnChain,
  logFeedbackOnChain,
  logRecordingHashOnChain,
  hashRecordingFile,
} from "./contracts/compliance-log";

export {
  createSessionKey,
  isSessionKeyValid,
  revokeSessionKey,
} from './contracts/smart-account';

// Helpers
export { withRetry, type RetryOptions }             from './helpers/retry';
export { buildConsentMessage, verifyConsentSignature } from './helpers/consent';
export { estimateGasWithBuffer, getCurrentGasPrice }   from './helpers/gas';