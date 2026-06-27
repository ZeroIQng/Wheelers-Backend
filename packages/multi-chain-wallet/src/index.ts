// Core classes
export { VM } from './vm';
export { ChainWallet } from './IChainWallet';

// EVM
export { EVMVM, EVMChainWallet } from './evm/evm';
export * as evmUtils from './evm/utils';

// SVM
export { SVMVM, SVMChainWallet } from './svm/svm';
export * as svmUtils from './svm/utils';
export { transactionSenderAndConfirmationWaiter } from './svm/transactionSender';

// BIP32 / Mnemonic
export {
  GenerateNewMnemonic,
  ValidateMnemonic,
  GenerateSeed,
  EVMDeriveChildPrivateKey,
  SVMDeriveChildPrivateKey,
} from './walletBip32';

// Types & constants
export * from './types';
export { DefaultChains } from './constant';

// High-level wallet service
export { MultiChainWalletService } from './service';
export type {
  CryptoWallet,
  ChainAddress,
  DepositInfo,
  WithdrawParams,
  WithdrawResult,
} from './service';
