import { ChainWalletConfig } from "./types";

export const DefaultChains: ChainWalletConfig[] = [{
    chainId: 501,
    name: "Solana Mainnet",
    rpcUrl: "https://solana-mainnet.g.alchemy.com/v2/vB5mKztdJeFdz9RkW99Qf",
    explorerUrl: "https://explorer.solana.com", // e.g. Solana Explorer
    nativeToken: {
        name: "Solana",
        symbol: "SOL",
        decimals: 9,
    },
    testnet: false,
    logoUrl: "https://cryptologos.cc/logos/solana-sol-logo.png?v=040",
    vmType: "SVM"

}
    , {
    chainId: 1,
    name: "Ethereum Mainnet",
    rpcUrl: "https://eth-mainnet.g.alchemy.com/v2/pwvhaDUZ4qZ8Oy2QcyWfCQa_avpkVPnL",
    explorerUrl: "https://etherscan.io",
    nativeToken: {
        name: "Ether",
        symbol: "ETH",
        decimals: 18,
    },
    testnet: false,
    logoUrl: "https://cryptologos.cc/logos/ethereum-eth-logo.png?v=040",
    vmType: "EVM"
}, {
    chainId: 56,
    name: "BNB Smart Chain Mainnet",
    rpcUrl: "https://bsc-dataseed.binance.org/",
    explorerUrl: "https://bscscan.com",
    nativeToken: {
        name: "Binance Coin",
        symbol: "BNB",
        decimals: 18,
    },
    testnet: false,
    logoUrl: "https://cryptologos.cc/logos/bnb-bnb-logo.png?v=040",
    vmType: "EVM"
}, {
    chainId: 501,
    name: "Eclipse Mainnet",
    rpcUrl: "https://mainnetbeta-rpc.eclipse.xyz",
    explorerUrl: "https://explorer.eclipse.xyz/", // e.g. Solana Explorer
    nativeToken: {
        name: "Eclipse",
        symbol: "ETH",
        decimals: 9,
    },
    testnet: false,
    logoUrl: "https://raw.githubusercontent.com/hyperlane-xyz/hyperlane-registry/a86c3b432b6f9ad7272ae09859f20eb3ade3bd6e/deployments/warp_routes/ES/logo.svg",
    vmType: "SVM"
},
{
    chainId: 16661,
    name: "0G Mainnet",
    rpcUrl: "https://evmrpc.0g.ai",
    explorerUrl: "https://chainscan.0g.ai/", // e.g. Solana Explorer
    nativeToken: {
        name: "OG Mainnet",
        symbol: "0G",
        decimals: 18,
    },
    testnet: false,
    logoUrl: "https://chainscan.0g.ai/static/media/zg-logo-new.b22d59dabf457524325ca81c29a4e055.svg",
    vmType: "EVM"
},
{
    chainId: 1776,
    name: "Injective EVM Mainnet",
    rpcUrl: "https://sentry.evm-rpc.injective.network",
    explorerUrl: "https://blockscout.injective.network",
    nativeToken: {
        name: "Injective",
        symbol: "INJ",
        decimals: 18,
    },
    testnet: false,
    logoUrl: "https://cryptologos.cc/logos/injective-protocol-inj-logo.png?v=040",
    vmType: "EVM"
}


]
