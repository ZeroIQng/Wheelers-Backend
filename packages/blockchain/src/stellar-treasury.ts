import {
  Asset,
  BASE_FEE,
  Operation,
  TransactionBuilder,
} from '@stellar/stellar-sdk';
import {
  STELLAR_USDC_CODE,
  STELLAR_USDC_ISSUER,
  getStellarConfig,
  type StellarNetwork,
} from './chains/stellar.config';
import { getHorizonServer, getPlatformStellarKeypair } from './stellar.client';

export async function sendTreasuryStellarUsdcPayment(params: {
  destinationAddress: string;
  amount: number;
  network?: StellarNetwork;
}): Promise<{
  hash: string;
  sourceAddress: string;
  destinationAddress: string;
  amount: string;
  assetCode: string;
  assetIssuer: string;
  network: StellarNetwork;
}> {
  if (!Number.isFinite(params.amount) || params.amount <= 0) {
    throw new Error('Treasury Stellar payment amount must be a positive number.');
  }

  const network =
    params.network ??
    (process.env['STELLAR_NETWORK'] as StellarNetwork | undefined) ??
    'mainnet';
  const server = getHorizonServer(network);
  const platformKeypair = getPlatformStellarKeypair();
  const sourceAccount = await server.loadAccount(platformKeypair.publicKey());
  const { networkPassphrase } = getStellarConfig(network);
  const asset = new Asset(STELLAR_USDC_CODE, STELLAR_USDC_ISSUER);
  const amount = formatStellarAmount(params.amount);

  const tx = new TransactionBuilder(sourceAccount, {
    fee: BASE_FEE,
    networkPassphrase,
  })
    .addOperation(
      Operation.payment({
        destination: params.destinationAddress,
        asset,
        amount,
      }),
    )
    .setTimeout(30)
    .build();

  tx.sign(platformKeypair);

  const response = await server.submitTransaction(tx);

  return {
    hash: response.hash,
    sourceAddress: platformKeypair.publicKey(),
    destinationAddress: params.destinationAddress,
    amount,
    assetCode: STELLAR_USDC_CODE,
    assetIssuer: STELLAR_USDC_ISSUER,
    network,
  };
}

function formatStellarAmount(value: number): string {
  return value.toFixed(7).replace(/\.?0+$/, '');
}
