import {
  BASE_FEE,
  Operation,
  TransactionBuilder,
} from '@stellar/stellar-sdk';
import { createHash } from 'node:crypto';
import { getStellarConfig, type StellarNetwork } from '../chains/stellar.config';
import { getHorizonServer, getPlatformStellarKeypair } from '../stellar.client';

export async function logFeedbackOnStellar(params: {
  feedbackId: string;
  rideId: string;
  revieweeWallet: string;
  rating: number;
  commentHash?: string;
  network?: StellarNetwork;
}): Promise<string> {
  return submitComplianceDataEntry({
    network: params.network,
    dataKey: `wheelers:fdbk:${params.feedbackId}`,
    dataValue: hashBuffer(
      [
        params.rideId,
        params.revieweeWallet.toLowerCase(),
        String(params.rating),
        params.commentHash ?? '',
      ].join(':'),
    ),
  });
}

export async function logRecordingHashOnStellar(params: {
  recordingId: string;
  rideId: string;
  sha256Hex: string;
  network?: StellarNetwork;
}): Promise<string> {
  return submitComplianceDataEntry({
    network: params.network,
    dataKey: `wheelers:rec:${params.recordingId}`,
    dataValue: parseHexBuffer(params.sha256Hex, `recording ${params.rideId} sha256 hash`),
  });
}

async function submitComplianceDataEntry(params: {
  dataKey: string;
  dataValue: Buffer;
  network?: StellarNetwork;
}): Promise<string> {
  if (Buffer.byteLength(params.dataKey, 'utf8') > 64) {
    throw new Error('Stellar compliance data key exceeds 64 bytes');
  }

  if (params.dataValue.length > 64) {
    throw new Error('Stellar compliance data value exceeds 64 bytes');
  }

  const network = params.network ?? (process.env['STELLAR_NETWORK'] as StellarNetwork | undefined) ?? 'testnet';
  const server = getHorizonServer(network);
  const platformKeypair = getPlatformStellarKeypair();
  const account = await server.loadAccount(platformKeypair.publicKey());
  const { networkPassphrase } = getStellarConfig(network);

  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase,
  })
    .addOperation(
      Operation.manageData({
        name: params.dataKey,
        value: params.dataValue,
      }),
    )
    .setTimeout(30)
    .build();

  tx.sign(platformKeypair);

  const response = await server.submitTransaction(tx);
  return response.hash;
}

function hashBuffer(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

function parseHexBuffer(value: string, label: string): Buffer {
  const normalized = value.startsWith('0x') ? value.slice(2) : value;

  if (!/^[a-fA-F0-9]+$/.test(normalized) || normalized.length % 2 !== 0) {
    throw new Error(`Invalid hex input for ${label}`);
  }

  return Buffer.from(normalized, 'hex');
}
