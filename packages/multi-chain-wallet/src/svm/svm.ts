import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { SVMDeriveChildPrivateKey } from "../walletBip32";
import { VM } from "../vm";
import { ChainWallet } from "../IChainWallet";
import { Balance, ChainWalletConfig, TokenInfo, TransactionResult } from "../types";
import {
    getSvmNativeBalance,
    getTokenBalance,
    getTransferNativeTransaction,
    getTransferTokenTransaction,
    signAndSendTransaction,
    getJupiterQuote,
    buildJupiterSwapTransaction,
    executeJupiterSwap,
    uiAmountToBaseUnits,
    validateJupiterTokens,
    JupiterQuoteResponse,
    getTokenInfo
} from "./utils";
import BN from "bn.js";
import nacl from "tweetnacl";
import base58 from "bs58";

export class SVMVM extends VM<PublicKey, Keypair, Connection> {
    getTokenInfo = getTokenInfo
    static validateAddress(address: PublicKey): boolean {
        try {
            new PublicKey(address)
            return true
        } catch (error) {
            return false

        }
    }
    derivationPath = "m/44'/501'/"; // Default SVM derivation path

    constructor(seed: string) {
        super(seed, "SVM");
    }

    static getNativeBalance(address: PublicKey, connection: Connection): Promise<Balance> {
        return getSvmNativeBalance(address, connection);
    }
    static async getTokenBalance(address: PublicKey, tokenAddress: PublicKey, connection: Connection): Promise<Balance> {
        const balance = await getTokenBalance(address, tokenAddress, connection);
        if (balance === 0) {
            return { balance: new BN(0), formatted: 0, decimal: 0 };
        }
        return { balance: new BN(balance.amount), formatted: balance.uiAmount || parseInt(balance.amount) / 10 ** balance.decimals, decimal: balance.decimals };
    }

    static signAndSendTransaction = signAndSendTransaction


    generatePrivateKey(index: number, seed?: string, mnemonic?: string, derivationPath = this.derivationPath) {
        let _seed: string

        if (seed) {
            _seed = seed
        } else if (mnemonic) {
            _seed = VM.mnemonicToSeed(mnemonic)
        } else {
            _seed = this.seed
        }
        const privateKey = SVMDeriveChildPrivateKey(_seed, index, derivationPath);
        return { privateKey, index };
    }
    static fromMnemonic(mnemonic: string): VM<PublicKey, Keypair, Connection> {
        const seed = VM.mnemonicToSeed(mnemonic)
        return new SVMVM(seed)
    }


}

export class SVMChainWallet extends ChainWallet<PublicKey, Keypair, Connection> {
    constructor(config: ChainWalletConfig, privateKey: Keypair, index: number) {
        super(config, privateKey, index);
        this.address = privateKey.publicKey;
        this.privateKey = privateKey;
        this.connection = new Connection(config.rpcUrl)
    }
    generateAddress() {
        return this.address;
    }
    async getNativeBalance(): Promise<Balance> {
        // Implement native balance retrieval logic here
        return await SVMVM.getNativeBalance(this.address, this.connection!)
    }

    async getTokenBalance(tokenAddress: PublicKey): Promise<Balance> {
        // Implement token balance retrieval logic here
        return await SVMVM.getTokenBalance(this.address, (tokenAddress), this.connection!);
    }

    async transferNative(to: PublicKey, amount: number): Promise<TransactionResult> {
        // Implement native transfer logic here
        const transaction = await getTransferNativeTransaction(this.privateKey, to, amount, this.connection!)
        const hash = await SVMVM.signAndSendTransaction(transaction, this.connection!, [this.privateKey]);
        return { success: true, hash } // Placeholder
    }

    async transferToken(token: TokenInfo, to: PublicKey, amount: number): Promise<TransactionResult> {
        // Implement token transfer logic here
        const transaction = await getTransferTokenTransaction(this.privateKey, new PublicKey(to), token, (amount), this.connection!);
        const hash = await SVMVM.signAndSendTransaction(transaction, this.connection!, [this.privateKey]);
        return { success: true, hash }; // Placeholder
    }


    // Updated SVMChainWallet swap methods with better defaults and debonk compatibility

    async swap(fromToken: TokenInfo, toToken: PublicKey, amount: number, slippage?: number): Promise<TransactionResult> {
        try {
            if (amount <= 0) {
                return {
                    success: false,
                    hash: "",
                    error: "Amount must be greater than 0"
                };
            }

            // Smart slippage handling
            // Expects slippage in BPS (basis points where 100 = 1%)
            // Default: 150 BPS = 1.5%
            // Range: 50-300 BPS = 0.5%-3%
            let slippageBps: number;

            if (slippage === undefined || slippage === null) {
                // No slippage provided - use 1.5% default (good for most swaps)
                slippageBps = 150;
                console.log('No slippage provided, using default: 150 BPS (1.5%)');
            } else {
                // Clamp between 50 BPS (0.5%) and 300 BPS (3%)
                // This prevents both too-tight and too-loose slippage
                if (slippage < 50) {
                    console.log(`Slippage ${slippage} BPS too low (< 0.5%), clamping to 50 BPS`);
                    slippageBps = 50;
                } else if (slippage > 300) {
                    console.log(`Slippage ${slippage} BPS too high (> 3%), clamping to 300 BPS`);
                    slippageBps = 300;
                } else {
                    slippageBps = slippage;
                    console.log(`Using provided slippage: ${slippageBps} BPS (${slippageBps / 100}%)`);
                }
            }

            const fromTokenMint = new PublicKey(fromToken.address);
            const toTokenMint = toToken;
            const baseAmount = uiAmountToBaseUnits(amount, fromToken.decimals);

            console.log('Swap details:', {
                from: fromTokenMint.toString(),
                to: toTokenMint.toString(),
                amount: baseAmount,
                slippageBps,
                slippagePercent: `${slippageBps / 100}%`
            });

            const swapResult = await executeJupiterSwap(
                {
                    fromToken: fromTokenMint,
                    toToken: toTokenMint,
                    amount: baseAmount,
                    slippageBps: slippageBps,
                    userPublicKey: this.address
                },
                this.connection!,
                this.privateKey
            );

            if (!swapResult.success) {
                return {
                    success: false,
                    hash: "",
                    error: swapResult.error || "Swap failed"
                };
            }

            return {
                success: true,
                hash: swapResult.hash || ""
            };

        } catch (error) {
            console.error("Swap error:", error);
            return {
                success: false,
                hash: "",
                error: error instanceof Error ? error.message : "Unknown swap error occurred"
            };
        }
    }

    async getSwapQuote(
        fromToken: TokenInfo,
        toToken: PublicKey,
        amount: number,
        slippage?: number
    ): Promise<{
        success: boolean;
        inputAmount?: string;
        outputAmount?: string;
        priceImpact?: string;
        routePlan?: JupiterQuoteResponse['routePlan'];
        slippageBps?: number;
        error?: string;
    }> {
        try {
            const fromTokenMint = new PublicKey(fromToken.address);
            const baseAmount = uiAmountToBaseUnits(amount, fromToken.decimals);

            // Use same smart slippage logic as swap()
            let slippageBps: number;

            if (slippage === undefined || slippage === null) {
                slippageBps = 150; // 1.5% default
            } else {
                // Clamp between 50-300 BPS
                slippageBps = Math.max(50, Math.min(300, slippage));
            }

            console.log('Getting quote with slippage:', slippageBps, 'BPS');

            const quote = await getJupiterQuote(
                fromTokenMint.toString(),
                toToken.toString(),
                baseAmount,
                slippageBps
            );

            return {
                success: true,
                inputAmount: quote.inAmount,
                outputAmount: quote.outAmount,
                priceImpact: quote.priceImpactPct,
                routePlan: quote.routePlan,
                slippageBps: quote.slippageBps
            };
        } catch (error) {
            return {
                success: false,
                error: error instanceof Error ? error.message : "Failed to get swap quote"
            };
        }
    }
    signMessage = (message: string, signer: Keypair) => {
        const messageBytes = new TextEncoder().encode(message);
        const signature = nacl.sign.detached(messageBytes, signer.secretKey);
        return base58.encode(signature);
    };
}