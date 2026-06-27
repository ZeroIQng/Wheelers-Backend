import { EVMVM, EVMChainWallet } from './evm/evm';
import { SVMVM, SVMChainWallet } from './svm/svm';
import { VM } from './vm';
import { GenerateNewMnemonic, ValidateMnemonic } from './walletBip32';
import { ChainWalletConfig, Balance, TransactionResult, TokenInfo } from './types';
import { DefaultChains } from './constant';
import { PublicKey, Keypair, Connection } from '@solana/web3.js';
import { JsonRpcProvider } from 'ethers';

// ── Types ──────────────────────────────────────────────────────────────

export interface ChainAddress {
  chainId: string | number;
  chainName: string;
  vmType: 'EVM' | 'SVM';
  address: string;
}

export interface CryptoWallet {
  mnemonic: string;
  encryptedMnemonic: string;
  encryptionSalt: string;
  addresses: ChainAddress[];
}

export interface DepositInfo {
  chainId: string | number;
  chainName: string;
  vmType: 'EVM' | 'SVM';
  address: string;
  nativeToken: { name: string; symbol: string; decimals: number };
}

export interface WithdrawParams {
  chainId: string | number;
  toAddress: string;
  amount: number;
  /** For token transfers, provide token info. Omit for native transfers. */
  token?: TokenInfo;
}

export interface WithdrawResult extends TransactionResult {
  chainId: string | number;
  chainName: string;
}

// ── Service ────────────────────────────────────────────────────────────

export class MultiChainWalletService {
  private chains: ChainWalletConfig[];

  constructor(chains?: ChainWalletConfig[]) {
    this.chains = chains || DefaultChains;
  }

  // ── Wallet creation ──────────────────────────────────────────────────

  /**
   * Create a brand new multi-chain wallet.
   * Generates a mnemonic, derives addresses for all configured chains,
   * and encrypts the mnemonic with the given password.
   */
  createWallet(password: string): CryptoWallet {
    if (!password || password.length < 1) {
      throw new Error('Password is required for wallet encryption');
    }
    const mnemonic = GenerateNewMnemonic();
    return this.importWallet(mnemonic, password);
  }

  /**
   * Import an existing wallet from a mnemonic phrase.
   * Derives addresses for all configured chains and encrypts the mnemonic.
   */
  importWallet(mnemonic: string, password: string): CryptoWallet {
    if (!password || password.length < 1) {
      throw new Error('Password is required for wallet encryption');
    }
    if (!mnemonic || mnemonic.trim().length === 0) {
      throw new Error('Mnemonic is required');
    }
    ValidateMnemonic(mnemonic);

    const { encrypted, salt } = VM.encryptSeedPhrase(mnemonic, password);
    const addresses = this.deriveAddresses(mnemonic, 0);

    return {
      mnemonic,
      encryptedMnemonic: encrypted,
      encryptionSalt: salt,
      addresses,
    };
  }

  /**
   * Recover a wallet from encrypted mnemonic.
   * Returns the decrypted mnemonic and all derived addresses.
   */
  recoverWallet(
    encryptedMnemonic: string,
    password: string,
    salt: string,
  ): CryptoWallet | null {
    const mnemonic = VM.decryptSeedPhrase(encryptedMnemonic, password, salt);
    if (!mnemonic) return null;

    const addresses = this.deriveAddresses(mnemonic, 0);
    const { encrypted, salt: newSalt } = VM.encryptSeedPhrase(mnemonic, password);

    return {
      mnemonic,
      encryptedMnemonic: encrypted,
      encryptionSalt: newSalt,
      addresses,
    };
  }

  // ── Deposit (get receive addresses) ──────────────────────────────────

  /**
   * Get deposit/receive addresses for all chains.
   * Users send crypto to these addresses to deposit into their wallet.
   */
  getDepositAddresses(mnemonic: string, index: number = 0): DepositInfo[] {
    const addresses = this.deriveAddresses(mnemonic, index);

    return addresses.map((addr) => {
      const chain = this.chains.find(
        (c) => c.chainId === addr.chainId && c.name === addr.chainName,
      )!;
      return {
        chainId: addr.chainId,
        chainName: addr.chainName,
        vmType: addr.vmType,
        address: addr.address,
        nativeToken: chain.nativeToken,
      };
    });
  }

  /**
   * Get the deposit address for a specific chain.
   * When multiple chains share the same chainId (e.g. Solana & Eclipse both use 501),
   * pass chainName to disambiguate.
   */
  getDepositAddress(
    mnemonic: string,
    chainId: string | number,
    index: number = 0,
    chainName?: string,
  ): DepositInfo | null {
    const all = this.getDepositAddresses(mnemonic, index);
    if (chainName) {
      return all.find(
        (d) => String(d.chainId) === String(chainId) && d.chainName === chainName,
      ) || null;
    }
    return all.find((d) => String(d.chainId) === String(chainId)) || null;
  }

  // ── Balance ──────────────────────────────────────────────────────────

  /**
   * Get native token balance on a specific chain.
   */
  async getBalance(
    mnemonic: string,
    chainId: string | number,
    index: number = 0,
  ): Promise<Balance> {
    const wallet = this.getChainWallet(mnemonic, chainId, index);
    return wallet.getNativeBalance();
  }

  /**
   * Get token balance on a specific chain.
   */
  async getTokenBalance(
    mnemonic: string,
    chainId: string | number,
    tokenAddress: string,
    index: number = 0,
  ): Promise<Balance> {
    const chain = this.findChain(chainId);
    const wallet = this.getChainWallet(mnemonic, chainId, index);

    if (chain.vmType === 'SVM') {
      return (wallet as SVMChainWallet).getTokenBalance(new PublicKey(tokenAddress));
    }
    return (wallet as EVMChainWallet).getTokenBalance(tokenAddress);
  }

  /**
   * Get balances across all chains.
   */
  async getAllBalances(
    mnemonic: string,
    index: number = 0,
  ): Promise<Array<{ chainId: string | number; chainName: string; balance: Balance }>> {
    const results = await Promise.allSettled(
      this.chains.map(async (chain) => {
        const wallet = this.getChainWallet(mnemonic, chain.chainId, index);
        const balance = await wallet.getNativeBalance();
        return { chainId: chain.chainId, chainName: chain.name, balance };
      }),
    );

    return results
      .filter((r): r is PromiseFulfilledResult<any> => r.status === 'fulfilled')
      .map((r) => r.value);
  }

  // ── Withdraw / Transfer ──────────────────────────────────────────────

  /**
   * Withdraw native tokens from a chain wallet to an external address.
   */
  async withdraw(
    mnemonic: string,
    params: WithdrawParams,
    index: number = 0,
  ): Promise<WithdrawResult> {
    if (!params.toAddress || params.toAddress.trim().length === 0) {
      throw new Error('toAddress is required');
    }
    if (typeof params.amount !== 'number' || params.amount <= 0 || !isFinite(params.amount)) {
      throw new Error('amount must be a positive finite number');
    }

    const chain = this.findChain(params.chainId);

    // Validate address format for the target chain
    if (chain.vmType === 'SVM') {
      try {
        new PublicKey(params.toAddress);
      } catch {
        throw new Error(`Invalid Solana address: ${params.toAddress}`);
      }
    } else {
      const { ethers } = require('ethers') as typeof import('ethers');
      if (!ethers.isAddress(params.toAddress)) {
        throw new Error(`Invalid EVM address: ${params.toAddress}`);
      }
    }

    const wallet = this.getChainWallet(mnemonic, params.chainId, index);

    let result: TransactionResult;

    if (params.token) {
      if (chain.vmType === 'SVM') {
        result = await (wallet as SVMChainWallet).transferToken(
          params.token,
          new PublicKey(params.toAddress),
          params.amount,
        );
      } else {
        result = await (wallet as EVMChainWallet).transferToken(
          params.token,
          params.toAddress,
          params.amount,
        );
      }
    } else {
      if (chain.vmType === 'SVM') {
        result = await (wallet as SVMChainWallet).transferNative(
          new PublicKey(params.toAddress),
          params.amount,
        );
      } else {
        result = await (wallet as EVMChainWallet).transferNative(
          params.toAddress,
          params.amount,
        );
      }
    }

    return {
      ...result,
      chainId: chain.chainId,
      chainName: chain.name,
    };
  }

  // ── Swap ─────────────────────────────────────────────────────────────

  /**
   * Swap tokens on a specific chain.
   */
  async swap(
    mnemonic: string,
    chainId: string | number,
    tokenIn: TokenInfo,
    tokenOutAddress: string,
    amount: number,
    slippage?: number,
    index: number = 0,
  ): Promise<TransactionResult> {
    const chain = this.findChain(chainId);
    const wallet = this.getChainWallet(mnemonic, chainId, index);

    if (chain.vmType === 'SVM') {
      return (wallet as SVMChainWallet).swap(
        tokenIn,
        new PublicKey(tokenOutAddress),
        amount,
        slippage,
      );
    }
    return (wallet as EVMChainWallet).swap(tokenIn, tokenOutAddress, amount, slippage);
  }

  // ── Internal helpers ─────────────────────────────────────────────────

  private findChain(chainId: string | number, chainName?: string): ChainWalletConfig {
    let chain: ChainWalletConfig | undefined;
    if (chainName) {
      chain = this.chains.find(
        (c) => String(c.chainId) === String(chainId) && c.name === chainName,
      );
    } else {
      chain = this.chains.find((c) => String(c.chainId) === String(chainId));
    }
    if (!chain) throw new Error(`Chain ${chainId} not configured`);
    return chain;
  }

  private deriveAddresses(mnemonic: string, index: number): ChainAddress[] {
    if (index < 0 || !Number.isInteger(index)) {
      throw new Error('Derivation index must be a non-negative integer');
    }

    const seed = VM.mnemonicToSeed(mnemonic);
    const evmVM = new EVMVM(seed);
    const svmVM = new SVMVM(seed);

    return this.chains.map((chain) => {
      if (!chain.vmType) {
        throw new Error(`Chain "${chain.name}" (${chain.chainId}) is missing vmType`);
      }

      if (chain.vmType === 'SVM') {
        const { privateKey } = svmVM.generatePrivateKey(index);
        const wallet = new SVMChainWallet(chain, privateKey, index);
        return {
          chainId: chain.chainId,
          chainName: chain.name,
          vmType: 'SVM' as const,
          address: wallet.getAddress().toBase58(),
        };
      } else {
        const { privateKey } = evmVM.generatePrivateKey(index);
        const wallet = new EVMChainWallet(chain, `0x${privateKey}`, index);
        return {
          chainId: chain.chainId,
          chainName: chain.name,
          vmType: 'EVM' as const,
          address: wallet.getAddress(),
        };
      }
    });
  }

  private getChainWallet(
    mnemonic: string,
    chainId: string | number,
    index: number,
  ): EVMChainWallet | SVMChainWallet {
    if (index < 0 || !Number.isInteger(index)) {
      throw new Error('Derivation index must be a non-negative integer');
    }

    const chain = this.findChain(chainId);

    if (!chain.vmType) {
      throw new Error(`Chain "${chain.name}" (${chain.chainId}) is missing vmType`);
    }

    const seed = VM.mnemonicToSeed(mnemonic);

    if (chain.vmType === 'SVM') {
      const vm = new SVMVM(seed);
      const { privateKey } = vm.generatePrivateKey(index);
      return new SVMChainWallet(chain, privateKey, index);
    } else {
      const vm = new EVMVM(seed);
      const { privateKey } = vm.generatePrivateKey(index);
      return new EVMChainWallet(chain, `0x${privateKey}`, index);
    }
  }
}
