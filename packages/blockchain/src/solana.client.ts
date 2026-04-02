import { Connection, Keypair } from '@solana/web3.js';
import { getSolanaRpcUrl }     from "../src/chains/solana.config";
import bs58                    from 'bs58';

let connection: Connection | null = null;

// Singleton Connection — reused across all Solana calls in the process.
export function getSolanaConnection(): Connection {
  if (connection) return connection;
  connection = new Connection(getSolanaRpcUrl(), 'confirmed');
  return connection;
}

// Platform keypair from env — used for signing Solana transactions.
// SOLANA_PRIVATE_KEY should be a base58-encoded private key.
export function getPlatformKeypair(): Keypair {
  const key = process.env['SOLANA_PRIVATE_KEY'];
  if (!key) throw new Error('[blockchain] SOLANA_PRIVATE_KEY is not set');
  return Keypair.fromSecretKey(bs58.decode(key));
}