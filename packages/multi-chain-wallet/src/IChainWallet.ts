import { Balance, ChainWalletConfig, NFTInfo, TokenInfo, TransactionResult } from "./types";

export abstract class ChainWallet<AddressType, PrivateKeyType, ConnectionType> {
    protected privateKey: PrivateKeyType;
    config: ChainWalletConfig;
    address: AddressType;
    index: number | undefined
    connection: ConnectionType | undefined

    constructor(config: ChainWalletConfig, privateKey: PrivateKeyType, index?: number) {
        this.config = config;
        this.privateKey = privateKey;
        this.address = this.generateAddress(privateKey);
        this.index = index;

    }

    abstract generateAddress(privateKey: PrivateKeyType): AddressType;
    abstract getNativeBalance(): Promise<Balance>;
    abstract getTokenBalance(tokenAddress: AddressType): Promise<Balance>;
    abstract transferNative(to: AddressType, amount: number): Promise<TransactionResult>;
    abstract transferToken(tokenAddress: TokenInfo, to: AddressType, amount: number): Promise<TransactionResult>;
    abstract swap (tokenAddress: TokenInfo, to: AddressType, amount: number, slippage?: number): Promise<TransactionResult>;

    // abstract transferNFT(contractAddress: AddressType, tokenId: string, to: string): Promise<TransactionResult>;
    // abstract getTokenInfo(tokenAddress: string): Promise<TokenInfo>;
    // abstract getNFTInfo(contractAddress: string, tokenId: string): Promise<NFTInfo>;
    // abstract getTransactionHistory(): Promise<any[]>;

    getAddress(): AddressType {
        return this.address;
    }

    getChainWalletConfig(): ChainWalletConfig {
        return this.config;
    }

}
