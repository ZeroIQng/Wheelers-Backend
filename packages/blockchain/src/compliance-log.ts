import { getPublicClient, getWalletClient } from '../src/evm.client';
import { type SupportedEvmChain }           from '../src/chains/evm.config';
import { hexToBytes, keccak256, toHex }     from 'viem';
import { createHash }                        from 'crypto';
import ComplianceLogAbi                      from '../src/abi/ComplianceLog.abi.json';

function getContractAddress(): `0x${string}` {
  const addr = process.env['COMPLIANCE_LOG_CONTRACT'];
  if (!addr) throw new Error('[blockchain] COMPLIANCE_LOG_CONTRACT is not set');
  return addr as `0x${string}`;
}

// Logs a user's consent on-chain. Called by compliance-worker when
// USER_CONSENT_LOGGED event is consumed.
// Returns the transaction hash — stored in UserConsent.consentTxHash.
export async function logConsentOnChain(params: {
  userWallet:     `0x${string}`;
  consentType:    string;
  consentVersion: string;
  chain?:         SupportedEvmChain;
}): Promise<`0x${string}`> {
  const client = getWalletClient(params.chain);

  return client.writeContract({
    address:      getContractAddress(),
    abi:          ComplianceLogAbi,
    functionName: 'logConsent',
    args: [
      params.userWallet,
      params.consentType,
      params.consentVersion,
      BigInt(Math.floor(Date.now() / 1000)),
    ],
  });
}

// Checks on-chain whether a wallet has valid consent for a given type/version.
// ride-service calls this before starting a recording to ensure consent is
// verifiable on-chain, not just in the DB.
export async function verifyConsentOnChain(params: {
  userWallet:     `0x${string}`;
  consentType:    string;
  consentVersion: string;
  chain?:         SupportedEvmChain;
}): Promise<boolean> {
  const client = getPublicClient(params.chain);

  return client.readContract({
    address:      getContractAddress(),
    abi:          ComplianceLogAbi,
    functionName: 'hasValidConsent',
    args: [params.userWallet, params.consentType, params.consentVersion],
  }) as Promise<boolean>;
}

// Logs a post-ride rating on-chain. Only the comment hash is stored —
// not the comment itself — to protect user privacy while keeping the
// rating tamper-proof.
export async function logFeedbackOnChain(params: {
  rideId:         string;
  revieweeWallet: `0x${string}`;
  rating:         number;
  comment?:       string;
  chain?:         SupportedEvmChain;
}): Promise<`0x${string}`> {
  const client = getWalletClient(params.chain);
  const commentHash = params.comment
    ? hashStringToBytes32(params.comment)
    : (`0x${'00'.repeat(32)}` as `0x${string}`);

  return client.writeContract({
    address:      getContractAddress(),
    abi:          ComplianceLogAbi,
    functionName: 'logFeedback',
    args: [params.rideId, params.revieweeWallet, params.rating, commentHash],
  });
}

// Logs the SHA-256 hash of an encrypted recording on-chain.
// The actual file lives on IPFS — only the hash is on-chain.
// Returns the tx hash stored in Recording.sha256Hash and used for dispute evidence.
export async function logRecordingHashOnChain(params: {
  rideId:    string;
  sha256Hex: string;  // 64-char hex string
  chain?:    SupportedEvmChain;
}): Promise<`0x${string}`> {
  const client = getWalletClient(params.chain);
  const bytes32Hash = `0x${params.sha256Hex}` as `0x${string}`;

  return client.writeContract({
    address:      getContractAddress(),
    abi:          ComplianceLogAbi,
    functionName: 'logRecording',
    args: [params.rideId, bytes32Hash],
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

// SHA-256 hash of a recording file buffer — used before uploading to IPFS.
// The hash is what gets stored on-chain, not the file itself.
export function hashRecordingFile(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

// Hashes a string to a 32-byte hex value suitable for bytes32 contract args.
function hashStringToBytes32(str: string): `0x${string}` {
  return keccak256(toHex(str));
}