import BN from "bn.js"
import { EVMVM } from "./evm";
import { SVMVM } from "./svm";

export interface ChainWalletConfig {
    chainId: string | number;
    name: string;
    rpcUrl: string;
    explorerUrl: string;

    nativeToken: {
        name: string;
        symbol: string;
        decimals: number;
    };
    logoUrl?: string
    confirmationNo?: number
    testnet?: boolean;
    vmType?: vmTypes
}

export interface TokenInfo {
    address: string;
    name: string;
    symbol: string;
    decimals: number;
}

export interface NFTInfo {
    tokenId: string;
    contractAddress: string;
    name?: string;
    description?: string;
    image?: string;
}

export interface TransactionResult {
    hash: string;
    success: boolean;
    error?: string;
}

export interface Balance {
    balance: BN;
    formatted: number;
    decimal: number
}


export const SUPPORTED_VM = {
    'EVM': EVMVM,
    'SVM': SVMVM
} as const;

export type vmTypes = keyof typeof SUPPORTED_VM;
