//we will write all the svm utils function here

import { Account, createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction, getAccount, getAssociatedTokenAddress, getAssociatedTokenAddressSync, getMint, Mint, NATIVE_MINT, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { TokenInfo } from "../types";
import { transactionSenderAndConfirmationWaiter } from "./transactionSender";
import { BN } from "bn.js";

const JUPITER_BASE_URL = 'https://lite-api.jup.ag';

export interface JupiterQuoteResponse {
    inputMint: string;
    inAmount: string;
    outputMint: string;
    outAmount: string;
    otherAmountThreshold: string;
    swapMode: string;
    slippageBps: number;
    platformFee: null | any;
    priceImpactPct: string;
    routePlan: RoutePlan[];
    contextSlot: number;
    timeTaken: number;
}
interface RoutePlan {
    swapInfo: SwapInfo;
    percent: number;
}

interface SwapInfo {
    ammKey: string;
    label: string;
    inputMint: string;
    outputMint: string;
    inAmount: string;
    outAmount: string;
    feeAmount: string;
    feeMint: string;
}

interface JupiterSwapResponse {
    swapTransaction: string;
    lastValidBlockHeight: number;
    prioritizationFeeLamports: number;
}
interface SwapParams {
    fromToken: PublicKey;
    toToken: PublicKey;
    amount: number;
    slippageBps?: number;
    userPublicKey: PublicKey;
}

interface SwapResult {
    success: boolean;
    hash?: string;
    error?: string;
    inputAmount?: string;
    outputAmount?: string;
    priceImpact?: string;
}


export const createV0Transaction = async (
    connection: Connection,
    inX: TransactionInstruction[],
    signers: Keypair[],
    payerPubKey: PublicKey,
    blockHash?: string
) => {
    console.log('createV0Transaction: Starting transaction creation');
    console.log('Instructions count:', inX.length);
    console.log('Signers count:', signers.length);
    console.log('Payer public key:', payerPubKey.toString());

    const blockhash =
        blockHash || (await connection.getLatestBlockhash()).blockhash;
    console.log('Using blockhash:', blockhash);

    const message = new TransactionMessage({
        payerKey: payerPubKey,
        instructions: inX,
        recentBlockhash: blockhash,
    }).compileToV0Message();

    const transaction = new VersionedTransaction(message);
    transaction.message.staticAccountKeys;
    if (signers.length < 1) {
        console.log('Signing transaction with signers');
        transaction.sign(signers);
    }

    console.log('createV0Transaction: Transaction created successfully');
    return transaction;
};

export const createAtaAndIx = async (
    token: PublicKey,
    ownerPublicKey: PublicKey,
    tokenProgramId: PublicKey,
    connection: Connection,
) => {
    console.log('createAtaAndIx: Starting ATA creation');
    console.log('Token:', token.toString());
    console.log('Owner:', ownerPublicKey.toString());
    console.log('Token Program ID:', tokenProgramId.toString());

    let AtaTokenIx;
    const associatedToken = getAssociatedTokenAddressSync(
        token,
        ownerPublicKey,
        false,
        tokenProgramId
    );
    console.log('Associated token address:', associatedToken.toString());

    const accountExist = await connection.getAccountInfo(associatedToken);
    if (!accountExist) {
        console.log('Account does not exist, creating ATA instruction');
        AtaTokenIx = createAssociatedTokenAccountIdempotentInstruction(
            ownerPublicKey,
            associatedToken,
            ownerPublicKey,
            token,
            tokenProgramId
        );
    } else {
        console.log('Account already exists, no ATA instruction needed');
    }

    console.log('createAtaAndIx: Completed');
    return {
        AtaTokenIx,
        associatedToken,
    };
};

export const getSureAssociatedTokenAddressAndAccount = async (
    connection: Connection,
    token: PublicKey,
    owner: PublicKey,
) => {
    console.log('getSureAssociatedTokenAddressAndAccount: Starting');
    console.log('Token:', token.toString());
    console.log('Owner:', owner.toString());

    let ATA: PublicKey;
    let programId: PublicKey;
    let tokenAccount: Account;
    try {
        programId = token.equals(NATIVE_MINT)
            ? TOKEN_PROGRAM_ID
            : TOKEN_2022_PROGRAM_ID;
        console.log('Trying with program ID:', programId.toString());

        ATA = getAssociatedTokenAddressSync(token, owner, true, programId);
        console.log('ATA address:', ATA.toString());

        tokenAccount = await getAccount(connection, ATA, "confirmed", programId);
        console.log('Token account found with TOKEN_2022_PROGRAM_ID');
        return { ATA, programId, tokenAccount };
    } catch (error) {
        console.log('Failed with TOKEN_2022_PROGRAM_ID, trying TOKEN_PROGRAM_ID');
        console.log('Error:', error);

        programId = TOKEN_PROGRAM_ID;
        ATA = getAssociatedTokenAddressSync(token, owner, true, programId);
        console.log('New ATA address:', ATA.toString());

        tokenAccount = await getAccount(connection, ATA, "confirmed", programId);
        console.log('Token account found with TOKEN_PROGRAM_ID');
        return { ATA, programId, tokenAccount };
    }
};

export const getProgramIdOfToken = async (owner: PublicKey, token: PublicKey, connection: Connection) => {

    if (token.equals(NATIVE_MINT)) {

        return TOKEN_PROGRAM_ID;
    }
    let ATA: PublicKey;
    let programId: PublicKey = TOKEN_PROGRAM_ID
    let tokenAccount: Account;
    try {
        ATA = getAssociatedTokenAddressSync(token, owner, true, programId);
        tokenAccount = await getAccount(connection, ATA, "confirmed", programId);

        return TOKEN_PROGRAM_ID
    } catch (error) {
        console.log('Failed with TOKEN_PROGRAM_ID, returning TOKEN_2022_PROGRAM_ID');
        return TOKEN_2022_PROGRAM_ID;
    }
}

//get native balance
export const getSvmNativeBalance = async (address: PublicKey, connection: Connection,) => {
    const balance = await connection.getBalance(address);
    return { balance: new BN(balance), formatted: balance / LAMPORTS_PER_SOL, decimal: 9 };
};

export const getTokenBalance = async (address: PublicKey, token: PublicKey, connection: Connection) => {


    try {
        // Get the balance from the token account
        const tokenAccount = await getTokenAccountAccount(token, address, connection);
        if (!tokenAccount) {
            console.log("Token account not found");
            return 0;
        }
        console.log('Token account found:', tokenAccount.address.toString());

        const tokenBalance = await connection.getTokenAccountBalance(
            tokenAccount.address
        );

        if (!tokenBalance) {
            console.log("Token balance not found");
            return 0;
        }

        console.log('Token balance:', tokenBalance.value);
        return tokenBalance.value;

    } catch (error) {
        console.log('Error in getTokenBalance:', error);
        return 0;
    }
}

export const getTokenAccountAccount = async (token: PublicKey, address: PublicKey, connection: Connection): Promise<Account | null> => {

    try {
        // Get the associated token account address for the user and the token mint
        const associatedTokenAccount = await getAssociatedTokenAddress(
            token, // The token mint address
            address // The user's public key
        );
        console.log('Associated token account:', associatedTokenAccount.toString());

        // Fetch the token account information
        const tokenAccount = await getAccount(
            connection,
            associatedTokenAccount
        );

        console.log('Token account retrieved successfully');
        return tokenAccount;
    } catch (error) {
        console.log("Not token account for this");
        return null;
    }
};

export const getTransferNativeInx = async (from: PublicKey, to: PublicKey, amount: number): Promise<TransactionInstruction> => {


    return SystemProgram.transfer({
        fromPubkey: from,
        toPubkey: to,
        lamports: amount * LAMPORTS_PER_SOL, // Convert SOL to lamports
    })
}

export const getTransferNativeTransaction = async (from: Keypair, to: PublicKey, amount: number, connection: Connection) => {
    console.log('getTransferNativeTransaction: Starting');
    const instruction = await getTransferNativeInx(from.publicKey, to, amount);
    const transaction = await createV0Transaction(connection, [instruction], [from], from.publicKey);
    console.log('getTransferNativeTransaction: Completed');
    return transaction;
}

export const getTokenInfo = async (tokenAddress: PublicKey, connection: Connection): Promise<TokenInfo> => {
    let mint: Mint
    try {
        mint = await getMint(connection, tokenAddress, "confirmed", TOKEN_PROGRAM_ID)

    } catch (error) {
        console.log('error: ', error);
        mint = await getMint(connection, tokenAddress, "confirmed", TOKEN_2022_PROGRAM_ID)


    }

    return {
        address: tokenAddress.toString(),
        decimals: mint.decimals,
        name: "",
        symbol: ""
    }
}

export const getTransferTokenInx = async (from: PublicKey, to: PublicKey, token: TokenInfo, amount: number, connection: Connection): Promise<TransactionInstruction[]> => {


    const inx: TransactionInstruction[] = []

    const tokenToSend = new PublicKey(token.address);
    console.log('Token to send:', tokenToSend.toString());

    const { ATA: source, programId, tokenAccount } = await getSureAssociatedTokenAddressAndAccount(connection, from, tokenToSend);
    console.log('Source ATA:', source.toString());

    const { associatedToken: destination, AtaTokenIx } = await createAtaAndIx(tokenToSend, to, programId, connection);
    console.log('Destination ATA:', destination.toString());

    if (!tokenAccount) {
        console.log('Token account not found, throwing error');
        throw new Error("Token account not found");
    }
    if (AtaTokenIx) {
        console.log('Adding ATA creation instruction');
        inx.push(AtaTokenIx);
    }

    console.log('Creating transfer instruction');
    const tInx = createTransferCheckedInstruction(source, tokenToSend, destination, from, amount, token.decimals, undefined, programId)
    inx.push(tInx);

    console.log('getTransferTokenInx: Completed with', inx.length, 'instructions');
    return inx;
}

export const getTransferTokenTransaction = async (from: Keypair, to: PublicKey, token: TokenInfo, amount: number, connection: Connection): Promise<VersionedTransaction> => {
    console.log('getTransferTokenTransaction: Starting');
    const instruction = await getTransferTokenInx(from.publicKey, to, token, amount, connection);
    const transaction = await createV0Transaction(connection, instruction, [from], from.publicKey);
    console.log('getTransferTokenTransaction: Completed');
    return transaction;
}

export const signAndSendTransaction = async (transaction: VersionedTransaction, connection: Connection, signers: Keypair[]) => {
    console.log('signAndSendTransaction: Starting');
    console.log('Signers count:', signers.length);

    transaction.sign(signers)
    console.log('Transaction signed');

    const blockhash = await connection.getLatestBlockhash()
    console.log('Got latest blockhash:', blockhash.blockhash);

    console.log('Sending transaction...');
    const res = await transactionSenderAndConfirmationWaiter({
        connection,
        serializedTransaction: Buffer.from(transaction.serialize()),
        blockhashWithExpiryBlockHeight: {
            blockhash: blockhash.blockhash,
            lastValidBlockHeight: blockhash.lastValidBlockHeight
        }
    });

    if (!res) {
        console.log('Transaction failed to send or confirm');
        throw new Error("Transaction failed to send or confirm");
    }

    const signature = res.transaction.signatures[0];
    console.log('Transaction successful, signature:', signature);
    return signature;
}

//swap
//you will. use jupiter for this

export const getJupiterQuote = async (
    inputMint: string,
    outputMint: string,
    amount: number,
    slippageBps: number = 100
): Promise<JupiterQuoteResponse> => {
    // console.log('getJupiterQuote: Starting');
    // console.log('Input mint:', inputMint);
    // console.log('Output mint:', outputMint);
    // console.log('Amount:', amount);
    // console.log('Slippage BPS:', slippageBps);

    const params = new URLSearchParams({
        inputMint,
        outputMint,
        amount: amount.toString(),
        slippageBps: slippageBps.toString(),
        onlyDirectRoutes: 'false',
        asLegacyTransaction: 'false'
    });

    const url = `${JUPITER_BASE_URL}/swap/v1/quote?${params}`;
    console.log('Request URL:', url);

    const response = await fetch(url);
    console.log('Response status:', response.status);
    console.log('Response status text:', response.statusText);

    if (!response.ok) {
        console.log('Jupiter quote request failed');
        console.log('Status:', response.status);
        console.log('Status Text:', response.statusText);
        console.log('URL:', url);

        try {
            const error = await response.json();
            console.log('Error details:', error);
        } catch {
            const textError = await response.text();
            console.log('Error text:', textError);
        }

        throw new Error(`Jupiter quote failed: ${response.statusText}`);
    }

    const result = await response.json() as JupiterQuoteResponse;
    console.log('Jupiter quote successful');
    console.log('Quote result:', result);
    return result;
};

export const buildJupiterSwapTransaction = async (
    quote: JupiterQuoteResponse,
    userPublicKey: string,
    prioritizationFeeLamports?: number,
    useSharedAccounts: boolean = true
): Promise<JupiterSwapResponse> => {
    console.log('buildJupiterSwapTransaction: Starting');
    console.log('User public key:', userPublicKey);
    console.log('Use shared accounts:', useSharedAccounts);
    
    const priorityFee = prioritizationFeeLamports || 5000;
    console.log('Prioritization fee:', priorityFee);
    
    const body = {
        quoteResponse: quote,
        userPublicKey,
        wrapAndUnwrapSol: true,
        useSharedAccounts: useSharedAccounts,
        feeAccount: undefined,
        trackingAccount: undefined,
        computeUnitPriceMicroLamports: undefined,
        prioritizationFeeLamports: priorityFee,
        asLegacyTransaction: false,
        useTokenLedger: false,
        destinationTokenAccount: undefined,
        dynamicComputeUnitLimit: true,
        skipUserAccountsRpcCalls: true
    };

    console.log('Request body:', body);

    const response = await fetch(`${JUPITER_BASE_URL}/swap/v1/swap`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
    });

    console.log('Swap transaction build response status:', response.status);

    if (!response.ok) {
        console.log('Jupiter swap transaction build failed');
        console.log('Status:', response.status);
        console.log('Status text:', response.statusText);

        try {
            const error = await response.json() as any;
            console.log('Swap build error details:', error);

            // Check if this is the shared accounts error
            if (error.errorCode === 'NOT_SUPPORTED' &&
                error.error?.includes('Simple AMMs are not supported with shared accounts')) {
                console.log('Detected shared accounts incompatibility error');
                throw new Error('SHARED_ACCOUNTS_NOT_SUPPORTED');
            }

            throw new Error(`Jupiter swap transaction build failed: ${error.message || response.statusText}`);
        } catch (parseError) {
            console.log('Failed to parse error response:', parseError);
            
            // Re-throw if it's our custom error
            if (parseError instanceof Error && parseError.message === 'SHARED_ACCOUNTS_NOT_SUPPORTED') {
                throw parseError;
            }
            
            throw new Error(`Jupiter swap transaction build failed: ${response.statusText}`);
        }
    }

    const result = await response.json() as JupiterSwapResponse;
    console.log('Jupiter swap transaction built successfully');
    return result;
};

export const executeJupiterSwap = async (
    swapParams: SwapParams,
    connection: Connection,
    payer: Keypair
): Promise<SwapResult> => {
    console.log('executeJupiterSwap: Starting');
    console.log('Swap params:', {
        fromToken: swapParams.fromToken.toString(),
        toToken: swapParams.toToken.toString(),
        amount: swapParams.amount,
        slippageBps: swapParams.slippageBps,
        userPublicKey: swapParams.userPublicKey.toString()
    });

    try {
        console.log('Getting Jupiter quote...');
        const quote = await getJupiterQuote(
            swapParams.fromToken.toString(),
            swapParams.toToken.toString(),
            swapParams.amount,
            swapParams.slippageBps
        );

        console.log('Quote received:', {
            inputAmount: quote.inAmount,
            outputAmount: quote.outAmount,
            priceImpact: quote.priceImpactPct
        });

        let swapResponse: JupiterSwapResponse;
        let usedSharedAccounts = true;

        try {
            console.log('Building swap transaction with shared accounts enabled...');
            swapResponse = await buildJupiterSwapTransaction(
                quote,
                swapParams.userPublicKey.toString(),
                undefined,
                true // Try with shared accounts first
            );
            console.log('Successfully built transaction with shared accounts');
        } catch (error) {
            if (error instanceof Error && error.message === 'SHARED_ACCOUNTS_NOT_SUPPORTED') {
                console.log('Shared accounts not supported, retrying without shared accounts...');
                
                // Retry without shared accounts
                swapResponse = await buildJupiterSwapTransaction(
                    quote,
                    swapParams.userPublicKey.toString(),
                    undefined,
                    false // Retry with shared accounts disabled
                );
                usedSharedAccounts = false;
                console.log('Successfully built transaction without shared accounts');
            } else {
                // Re-throw if it's a different error
                throw error;
            }
        }

        console.log('Transaction build method:', usedSharedAccounts ? 'with shared accounts' : 'without shared accounts');
        console.log('Deserializing transaction...');
        const swapTransactionBuf = Buffer.from(swapResponse.swapTransaction, 'base64');
        console.log('Transaction buffer length:', swapTransactionBuf.length);

        const transaction = VersionedTransaction.deserialize(swapTransactionBuf);
        console.log('Transaction deserialized successfully');

        console.log('Signing transaction...');
        transaction.sign([payer]);
        console.log('Transaction signed');

        console.log('Sending transaction...');
        const blockhash = await connection.getLatestBlockhash();
        console.log('Got latest blockhash for confirmation');

        const signature = await transactionSenderAndConfirmationWaiter({
            connection,
            serializedTransaction: Buffer.from(transaction.serialize()),
            blockhashWithExpiryBlockHeight: {
                blockhash: blockhash.blockhash,
                lastValidBlockHeight: blockhash.lastValidBlockHeight
            }
        });

        if (!signature) {
            console.log('Transaction failed to confirm');
            return {
                success: false,
                error: 'Transaction failed to confirm'
            };
        }

        const txSignature = signature.transaction.signatures[0];
        console.log('Swap successful! Signature:', txSignature);
        console.log('Used shared accounts:', usedSharedAccounts);

        return {
            success: true,
            hash: txSignature,
            inputAmount: quote.inAmount,
            outputAmount: quote.outAmount,
            priceImpact: quote.priceImpactPct
        };

    } catch (error) {
        console.log('Jupiter swap failed with error:', error);
        console.log('Error type:', typeof error);
        console.log('Error message:', error instanceof Error ? error.message : 'Unknown error');
        console.log('Error stack:', error instanceof Error ? error.stack : 'No stack trace');

        return {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error occurred'
        };
    }
};

export const uiAmountToBaseUnits = (uiAmount: number, decimals: number): number => {
    console.log('uiAmountToBaseUnits: Converting', uiAmount, 'with', decimals, 'decimals');
    const result = Math.floor(uiAmount * Math.pow(10, decimals));
    console.log('Converted to base units:', result);
    return result;
};

export const baseUnitsToUiAmount = (baseAmount: string | number, decimals: number): number => {
    console.log('baseUnitsToUiAmount: Converting', baseAmount, 'with', decimals, 'decimals');
    const result = Number(baseAmount) / Math.pow(10, decimals);
    console.log('Converted to UI amount:', result);
    return result;
};

export const getJupiterTokenList = async (): Promise<any[]> => {
    console.log('getJupiterTokenList: Fetching token list');
    try {
        const response = await fetch(`${JUPITER_BASE_URL}/tokens/v1/mints/tradable`);
        console.log('Token list response status:', response.status);

        if (!response.ok) {
            console.log('Failed to fetch token list:', response.statusText);
            throw new Error(`Failed to fetch token list: ${response.statusText}`);
        }
        const result = await response.json() as any[];
        console.log('Token list fetched, count:', result.length);
        return result;
    } catch (error) {
        console.log('Failed to fetch Jupiter token list:', error);
        return [];
    }
};

export const validateJupiterTokens = async (
    inputMint: string,
    outputMint: string
): Promise<{ valid: boolean; message?: string }> => {
    console.log('validateJupiterTokens: Starting validation');
    console.log('Input mint:', inputMint);
    console.log('Output mint:', outputMint);

    try {
        const tokenList = await getJupiterTokenList();
        const inputSupported = tokenList.includes(inputMint);
        const outputSupported = tokenList.includes(outputMint);

        console.log('Input token supported:', inputSupported);
        console.log('Output token supported:', outputSupported);

        if (!inputSupported && !outputSupported) {
            console.log('Both tokens not supported');
            return { valid: false, message: 'Both input and output tokens are not supported' };
        }
        if (!inputSupported) {
            console.log('Input token not supported');
            return { valid: false, message: 'Input token is not supported' };
        }
        if (!outputSupported) {
            console.log('Output token not supported');
            return { valid: false, message: 'Output token is not supported' };
        }

        console.log('Both tokens are supported');
        return { valid: true };
    } catch (error) {
        console.log('Token validation failed:', error);
        return { valid: false, message: 'Failed to validate tokens' };
    }
};