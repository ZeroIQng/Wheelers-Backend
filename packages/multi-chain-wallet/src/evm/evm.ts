/**
 *
 * @param phrase this is the pass phrase for this vm
 * this is a class that will be responsible for creating several evm wallets code
 */

import { EVMDeriveChildPrivateKey } from "../walletBip32";
import { ChainWallet } from "../IChainWallet";
import { Balance, ChainWalletConfig, NFTInfo, TokenInfo, TransactionResult } from "../types";
import { VM } from "../vm";
import { ethers, JsonRpcProvider, Wallet, formatUnits } from "ethers";
import BN from "bn.js";
import {
    getNativeBalance,
    getTokenBalance,
    sendERC20Token,
    sendNativeToken,
    performSwap,
    checkAndApprove,
    signSendAndConfirm,
    getNativeTokenAddress,
    prepareSwapParams,
    formatAmountToWei,
    isChainSupportedByKyber,
    isChainSupportedByDebonk,
    // normalizeTokenAddressForDebonk,
    convertSlippageForDebonk,
    TransactionParams,
    approveToken,
    executeContractMethod,
    getTokenInfo,
    DESERIALIZED_SUPPORTED_CHAINS
} from "./utils";

interface DebonkQuoteResponse {
    tokenA: string;
    tokenB: string;
    amountIn: string;
    amountOut: string;
    tokenPrice: string;
    routePlan: Array<{
        tokenA: string;
        tokenB: string;
        dexId: string;
        poolAddress: string;
        aToB: boolean;
        fee: number;
    }>;
    dexId: string;
    dexFactory: string;
}

interface DebonkSwapResponse {
    transactions: Array<{
        from: string;
        to: string;
        data: string;
        value: string;
        gasLimit?: string;
        gasPrice?: string;
    }>;
}

interface DebonkSwapResult {
    success: boolean;
    hash: string;
    error?: string;
}


export class EVMVM extends VM<string, string, JsonRpcProvider> {
    derivationPath = "m/44'/60'/0'/0/"; // Default EVM derivation path

    constructor(seed: string) {
        super(seed, "EVM");
    }

    getTokenInfo = getTokenInfo
    generatePrivateKey(index: number, seed?: string, mnemonic?: string, derivationPath = this.derivationPath) {
        let _seed: string

        if (seed) {
            _seed = seed
        } else if (mnemonic) {
            _seed = VM.mnemonicToSeed(mnemonic)
        } else {
            _seed = this.seed
        }
        const privateKey = EVMDeriveChildPrivateKey(_seed, index, derivationPath).privateKey;
        return { privateKey, index };
    }
    static fromMnemonic(mnemonic: string): VM<string, string, JsonRpcProvider> {
        const seed = VM.mnemonicToSeed(mnemonic)
        return new EVMVM(seed)
    }

    static validateAddress(address: string): boolean {
        return ethers.isAddress(address);
    }

    static async getNativeBalance(address: string, connection: JsonRpcProvider): Promise<Balance> {
        // Implement native balance retrieval logic here
        return await getNativeBalance(address, connection)
    }

    static async getTokenBalance(address: string, tokenAddress: string, connection: JsonRpcProvider): Promise<Balance> {
        // Implement token balance retrieval logic here
        return await getTokenBalance(tokenAddress, address, connection)
    }
}

export class EVMChainWallet extends ChainWallet<string, string, JsonRpcProvider> {
    constructor(config: ChainWalletConfig, privateKey: string, index: number) {
        super(config, privateKey, index);
        const wallet = new Wallet(privateKey);
        this.address = wallet.address;
        this.privateKey = privateKey;
        this.connection = new JsonRpcProvider(config.rpcUrl)
    }

    getWallet(): Wallet {
        return new Wallet(this.privateKey, this.connection);
    }

    generateAddress(): string {
        return this.address;
    }

    async getNativeBalance(): Promise<Balance> {
        // Implement native balance retrieval logic here
        return await EVMVM.getNativeBalance(this.address, this.connection!)
    }

    async getTokenBalance(tokenAddress: string): Promise<Balance> {
        // Implement token balance retrieval logic here
        return await EVMVM.getTokenBalance(this.address, tokenAddress, this.connection!)
    }

    async transferNative(to: string, amount: number): Promise<TransactionResult> {
        // Implement native transfer logic here
        const wallet = this.getWallet()
        return await sendNativeToken(wallet, to, amount.toString(), undefined, this.config.confirmationNo || 5)
    }

    async transferToken(tokenAddress: TokenInfo, to: string, amount: number): Promise<TransactionResult> {
        // Implement token transfer logic here
        const wallet = this.getWallet()
        return await sendERC20Token(wallet, tokenAddress.address, to, amount.toString(), undefined, this.config.confirmationNo || 5)
    }

    // Updated swap method signature to match base class so created another method to use it inside swap
    async swap(
        tokenAddress: TokenInfo,
        to: string,
        amount: number,
        slippage: number = 100
    ): Promise<TransactionResult> {
        if (amount <= 0) {
            return {
                success: false,
                hash: "",
                error: "Amount must be greater than 0"
            };
        }
        const tokenOut: TokenInfo = {
            address: to,
            name: '',
            symbol: '',
            decimals: 18
        };

        return await this.performCompleteSwap(tokenAddress, tokenOut, amount, slippage);
    }

    async performCompleteSwap(
        tokenIn: TokenInfo,
        tokenOut: TokenInfo,
        amount: number,
        slippage: number = 100,
        recipient?: string,
        deadline?: number
    ): Promise<TransactionResult> {
        try {
            const wallet = this.getWallet();
            const chainId = (await this.connection!.getNetwork()).chainId.toString();

            console.log(` Starting swap on chain ${chainId}:`, {
                from: tokenIn.symbol || tokenIn.address,
                to: tokenOut.symbol || tokenOut.address,
                amount: amount,
                slippage: `${slippage / 100}%`
            });

            // Check if this is a 0G chain that should use Debonk
            if (isChainSupportedByDebonk(chainId)) {
                console.log('Using Debonk API for 0G chain swap');
                return await this.performDebonkSwap(tokenIn, tokenOut, amount, slippage, recipient, deadline);
            }

            // Otherwise use Kyber (existing flow)
            console.log('Using KyberSwap for non-0G chain swap');
            return await this.performKyberSwap(tokenIn, tokenOut, amount, slippage, recipient, deadline);

        } catch (error) {
            console.error('Swap failed:', error);
            throw new Error(`Swap failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }

    private async performDebonkSwap(
        tokenIn: TokenInfo,
        tokenOut: TokenInfo,
        amount: number,
        slippage: number = 100,     // bps (e.g., 50 = 0.5%)
        recipient?: string,
        deadline?: number
    ): Promise<DebonkSwapResult> {
        try {
            const BASE_URL = 'https://evm-api.deserialize.xyz';
            const tokenInAddress = tokenIn.address;
            const tokenOutAddress = tokenOut.address;

            // Convert amount to wei (multiply by 10^18 for 18 decimal tokens)
            const amountInWei = (amount * Math.pow(10, tokenIn.decimals || 18)).toString();
            console.log("amountInWei", amountInWei)
            // Convert slippage from bps to percentage (e.g., 50 bps -> 0.5%)
            const slippagePercentage = slippage / 100;

            console.log("Debonk API swap params:", {
                tokenA: tokenInAddress,
                tokenB: tokenOutAddress,
                amountIn: amount,
                amountInWei: amountInWei,
                slippage: slippagePercentage,
            });

            // Step 1: Get quote from API
            console.log("Getting quote from Debonk API...");

            const quotePayload = {
                tokenA: tokenInAddress,
                tokenB: tokenOutAddress,
                amountIn: amountInWei, // Use wei amount
                dexId: "ZERO_G"
            };

            console.log("Quote request payload:", quotePayload);

            const quoteResponse = await fetch(`${BASE_URL}/quote`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(quotePayload)
            });

            if (!quoteResponse.ok) {
                const errorText = await quoteResponse.text();
                console.error("Quote API error response:", errorText);
                return this.fail(`Quote API failed: ${quoteResponse.status} ${errorText}`);
            }

            const quote: DebonkQuoteResponse = await quoteResponse.json() as DebonkQuoteResponse;
            console.log("Quote received:", JSON.stringify(quote, null, 2));

            // Step 2: Fix the quote dexId for swap API (it expects "ALL")
            const modifiedQuote = {
                ...quote,
                dexId: "ALL"  // Change from "ZERO_G" to "ALL" as required by swap API
            };

            console.log("Modified quote for swap API:", JSON.stringify(modifiedQuote, null, 2));

            // Step 3: Get wallet address
            const walletAddress = await this.getWallet().getAddress();
            console.log("Wallet address:", walletAddress);

            // Step 4: Call swap API with modified quote
            console.log("Calling swap API...");

            const swapPayload = {
                publicKey: walletAddress,
                slippage: slippagePercentage,
                quote: modifiedQuote

            };

            console.log("Swap request payload:", JSON.stringify(swapPayload, null, 2));

            const swapResponse = await fetch(`${BASE_URL}/swap`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(swapPayload)
            });

            if (!swapResponse.ok) {
                const errorText = await swapResponse.text();
                console.error("Swap API error response:", errorText);
                return this.fail(`Swap API failed: ${swapResponse.status} ${errorText}`);
            }

            const swapData: DebonkSwapResponse = await swapResponse.json() as DebonkSwapResponse;
            console.log("Swap API response:", JSON.stringify(swapData, null, 2));

            const wallet = this.getWallet();
            let lastTxHash = '';

            // Step 5: Execute each transaction sequentially
            console.log(`Executing ${swapData.transactions.length} transactions...`);

            for (let i = 0; i < swapData.transactions.length; i++) {
                const transaction = swapData.transactions[i];
                console.log(`Executing transaction ${i + 1} of ${swapData.transactions.length}`);

                // Prepare transaction object
                const txRequest = {
                    to: transaction.to,
                    data: transaction.data,
                    value: transaction.value,
                    // gasPrice: 70000000000,
                    // gasLimit: 70000, // Increase significantly
                };
                console.log("Prepared transaction request:", txRequest);
                console.log(`Transaction ${i + 1} request:`, txRequest);

                try {
                    const txResponse = await wallet.sendTransaction(txRequest);
                    console.log(`Transaction ${i + 1} sent:`, txResponse.hash);

                    // Wait for confirmation
                    const receipt = await txResponse.wait();

                    if (!receipt) {
                        return this.fail(`Transaction ${i + 1} failed - no receipt received`);
                    }

                    const txHash = receipt.hash || txResponse.hash;
                    lastTxHash = txHash;

                    console.log(`Transaction ${i + 1} confirmed:`, {
                        hash: txHash,
                        blockNumber: receipt.blockNumber,
                        gasUsed: receipt.gasUsed?.toString()
                    });

                } catch (txError: any) {
                    console.error(`Transaction ${i + 1} failed:`, txError);
                    return this.fail(`Transaction ${i + 1} failed: ${txError?.message ?? String(txError)}`);
                }
            }

            console.log("All transactions completed successfully");

            return {
                success: true,
                hash: lastTxHash // Return the hash of the last transaction
            };

        } catch (error: any) {
            console.error("Debonk API swap error:", error);
            return this.fail(`Debonk API swap failed: ${error?.message ?? String(error)}`);
        }
    }

    // Helper method for EVMChainWallet class
    private fail(message: string): DebonkSwapResult {
        return {
            success: false,
            hash: "",
            error: message
        };
    }


    private async performKyberSwap(
        tokenIn: TokenInfo,
        tokenOut: TokenInfo,
        amount: number,
        slippage: number = 50,
        recipient?: string,
        deadline?: number
    ): Promise<TransactionResult> {
        try {
            const wallet = this.getWallet();
            const chainId = (await this.connection!.getNetwork()).chainId.toString();

            if (!isChainSupportedByKyber(chainId)) {
                throw new Error(`Chain ${chainId} is not supported by KyberSwap`);
            }

            const isNativeIn = tokenIn.address === 'native' ||
                tokenIn.address.toLowerCase() === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
            const isNativeOut = tokenOut.address === 'native' ||
                tokenOut.address.toLowerCase() === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';

            let tokenInDecimals = 18;
            if (!isNativeIn && tokenIn.decimals) {
                tokenInDecimals = tokenIn.decimals;
            } else if (!isNativeIn) {
                const tokenBalance = await this.getTokenBalance(tokenIn.address);
                tokenInDecimals = tokenBalance.decimal;
            }

            const { tokenInAddress, tokenOutAddress, formattedAmountIn } = prepareSwapParams(
                tokenIn.address,
                tokenOut.address,
                amount.toString(),
                tokenInDecimals,
                isNativeIn,
                isNativeOut
            );

            console.log('Kyber swap parameters:', {
                tokenInAddress,
                tokenOutAddress,
                formattedAmountIn,
                tokenInDecimals
            });

            if (isNativeIn) {
                const nativeBalance = await this.getNativeBalance();
                const requiredAmount = new BN(formattedAmountIn);
                if (nativeBalance.balance.lt(requiredAmount)) {
                    throw new Error(`Insufficient native balance. Required: ${amount}, Available: ${nativeBalance.formatted}`);
                }
            } else {
                const tokenBalance = await this.getTokenBalance(tokenIn.address);
                const requiredAmount = new BN(formattedAmountIn);
                if (tokenBalance.balance.lt(requiredAmount)) {
                    throw new Error(`Insufficient token balance. Required: ${amount}, Available: ${tokenBalance.formatted}`);
                }
            }

            const swapTx = await performSwap({
                chainId,
                tokenIn: tokenInAddress,
                tokenOut: tokenOutAddress,
                amountIn: formattedAmountIn,
                sender: this.address,
                recipient: recipient || this.address,
                slippageTolerance: slippage,
                deadline: deadline ? Math.floor(Date.now() / 1000) + deadline : Math.floor(Date.now() / 1000) + 1200, // 20 minutes default
                clientId: 'EVMChainWallet'
            });

            console.log('Kyber swap transaction prepared:', {
                to: swapTx.to,
                dataLength: swapTx.data?.length || 0,
                gasLimit: swapTx.gasLimit?.toString(),
                value: swapTx.value?.toString()
            });

            if (!isNativeIn) {
                console.log('Checking token approval...');
                const approvalResult = await checkAndApprove(
                    wallet,
                    tokenIn.address,
                    swapTx.to,
                    formattedAmountIn,
                    undefined,
                    undefined,
                    this.config.confirmationNo || 1
                );

                if (approvalResult.approvalNeeded && approvalResult.approvalResult) {
                    if (!approvalResult.approvalResult.success) {
                        throw new Error('Token approval failed');
                    }
                    console.log('Token approval successful');
                } else if (approvalResult.approvalNeeded) {
                    throw new Error('Token approval was needed but failed');
                } else {
                    console.log('Token approval not needed - sufficient allowance');
                }
            }

            const result = await signSendAndConfirm(
                wallet,
                {
                    to: swapTx.to,
                    data: swapTx.data,
                    value: swapTx.value || '0',
                    gasLimit: swapTx.gasLimit
                },
                this.config.confirmationNo || 1,
            );

            if (result.success) {
                console.log(' Kyber swap completed successfully:', {
                    hash: result.hash,
                    gasUsed: result.gasUsed?.toString(),
                    blockNumber: result.blockNumber
                });
            } else {
                console.log(' Kyber swap failed:', result);
            }

            return result;

        } catch (error) {
            console.error('Kyber swap failed:', error);
            throw new Error(`Kyber swap failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }

    async getSwapQuote(
        tokenIn: TokenInfo,
        tokenOut: TokenInfo,
        amount: number
    ): Promise<{
        amountOut: string;
        priceImpact: string;
        gasEstimate: string;
        route: string[];
    }> {

        try {
            const chainId = (await this.connection!.getNetwork()).chainId.toString();

            if (!isChainSupportedByKyber(chainId)) {
                throw new Error(`Chain ${chainId} is not supported by KyberSwap`);
            }

            const isNativeIn = tokenIn.address === 'native' ||
                tokenIn.address.toLowerCase() === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
            const isNativeOut = tokenOut.address === 'native' ||
                tokenOut.address.toLowerCase() === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';

            let tokenInDecimals = 18;
            if (!isNativeIn && tokenIn.decimals) {
                tokenInDecimals = tokenIn.decimals;
            } else if (!isNativeIn) {
                const tokenBalance = await this.getTokenBalance(tokenIn.address);
                tokenInDecimals = tokenBalance.decimal;
            }

            const { tokenInAddress, tokenOutAddress, formattedAmountIn } = prepareSwapParams(
                tokenIn.address,
                tokenOut.address,
                amount.toString(),
                tokenInDecimals,
                isNativeIn,
                isNativeOut
            );

            throw new Error("Quote functionality requires direct API integration - use the swap method for full execution");

        } catch (error) {
            console.error('Error getting swap quote:', error);
            throw error;
        }
    }
    async approveToken(params: {
        tokenAddress: string
        spender: string
        amountRaw: string | bigint
        confirmations?: number
        gasLimit?: string | bigint
    }): Promise<TransactionResult> {
        const signer = this.getWallet()
        const r = await approveToken(
            signer,
            params.tokenAddress,
            params.spender,
            params.amountRaw,
            params.gasLimit,
            params.confirmations ?? this.config.confirmationNo ?? 1,
        )
        return {
            hash: r.hash,
            success: r.success,
            error: (r as any).error,
        }
    }

    async executeContractMethod(params: {
        contractAddress: string
        abi: any[]
        methodName: string
        methodParams?: any[]
        value?: string | bigint
        gasLimit?: string | bigint
        confirmations?: number
    }): Promise<TransactionResult> {
        const signer = this.getWallet()
        const r = await executeContractMethod(
            signer,
            params.contractAddress,
            params.abi,
            params.methodName,
            params.methodParams ?? [],
            params.value,
        )
        return {
            hash: r.hash,
            success: r.success,
            error: (r as any).error,
        }
    }
    async signMessage(message: string): Promise<string> {
        const signer = this.getWallet()
        return signer.signMessage(message)
    }
}