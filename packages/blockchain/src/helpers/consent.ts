import { verifyMessage } from 'viem';

// The canonical consent message riders and drivers sign in-app.
// This is signed off-chain via Privy's embedded wallet, then the signature
// is verified here before the on-chain log transaction is submitted.
export function buildConsentMessage(params: {
  userId:         string;
  consentType:    string;  // e.g. "RECORDING", "DEFI_TIER1"
  consentVersion: string;  // e.g. "v1.0"
  timestamp:      number;  // unix seconds
}): string {
  return [
    'Wheleers Consent Agreement',
    `User: ${params.userId}`,
    `Type: ${params.consentType}`,
    `Version: ${params.consentVersion}`,
    `Timestamp: ${params.timestamp}`,
    '',
    'By signing this message, you agree to the terms associated with the',
    'above consent type as described in the Wheleers Privacy Policy.',
  ].join('\n');
}

// Verifies that a signature was produced by the expected wallet address.
// Called before submitting the on-chain consent log — ensures the user
// actually signed the message and we're not logging consent on their behalf.
export async function verifyConsentSignature(params: {
  message:          string;
  signature:        `0x${string}`;
  expectedAddress:  `0x${string}`;
}): Promise<boolean> {
  try {
    const recoveredAddress = await verifyMessage({
      address:   params.expectedAddress,
      message:   params.message,
      signature: params.signature,
    });
    return recoveredAddress;
  } catch {
    return false;
  }
}