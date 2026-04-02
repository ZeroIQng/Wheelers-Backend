import { Horizon, Keypair } from '@stellar/stellar-sdk';
import { getStellarConfig, type StellarNetwork } from '../src/chains/stellar.config';

// Horizon is Stellar's REST API — used for submitting transactions
// and querying account balances.
export function getHorizonServer(network: StellarNetwork = 'mainnet'): Horizon.Server {
  const { horizonUrl } = getStellarConfig(network);
  return new Horizon.Server(horizonUrl);
}

// Platform Stellar keypair from env.
// STELLAR_SECRET_KEY should be a Stellar secret key (starts with 'S').
export function getPlatformStellarKeypair(): Keypair {
  const secret = process.env['STELLAR_SECRET_KEY'];
  if (!secret) throw new Error('[blockchain] STELLAR_SECRET_KEY is not set');
  return Keypair.fromSecret(secret);
}