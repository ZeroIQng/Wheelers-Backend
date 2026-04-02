    import { getPublicClient, getWalletClient } from '../evm.client';
import { type SupportedEvmChain }           from '../chains/evm.config';
import { encodeFunctionData, parseAbi }     from 'viem';

// Minimal ERC-4337 session key ABI — the full EntryPoint ABI is not needed
// for the operations Wheleers performs (session key creation and execution).
const SESSION_KEY_ABI = parseAbi([
  'function createSessionKey(address sessionKey, uint256 validUntil, bytes calldata permissions) external returns (bytes32 keyId)',
  'function executeWithSessionKey(bytes32 keyId, address target, uint256 value, bytes calldata data) external',
  'function revokeSessionKey(bytes32 keyId) external',
  'function isSessionKeyValid(bytes32 keyId) external view returns (bool)',
]);

// Creates a session key for a rider's smart account.
// This is what allows the DeFi scheduler to stake/unstake on behalf of the
// rider without requiring them to sign every transaction.
// The session key has a defined validity window and permission scope.
export async function createSessionKey(params: {
  smartAccountAddress: `0x${string}`;
  sessionKeyAddress:   `0x${string}`;  // platform key that can act on behalf of user
  validUntilTimestamp: number;          // unix timestamp
  chain?:              SupportedEvmChain;
}): Promise<`0x${string}`> {
  const client = getWalletClient(params.chain);

  return client.writeContract({
    address:      params.smartAccountAddress,
    abi:          SESSION_KEY_ABI,
    functionName: 'createSessionKey',
    // permissions is empty bytes — scoped by validUntil only for now.
    // In v2 this will carry DeFi protocol whitelists.
    args: [params.sessionKeyAddress, BigInt(params.validUntilTimestamp), '0x'],
  });
}

// Checks whether a session key is still valid on-chain.
// wallet-service calls this before attempting a session-key-signed DeFi op.
export async function isSessionKeyValid(params: {
  smartAccountAddress: `0x${string}`;
  keyId:               `0x${string}`;
  chain?:              SupportedEvmChain;
}): Promise<boolean> {
  const client = getPublicClient(params.chain);

  return client.readContract({
    address:      params.smartAccountAddress,
    abi:          SESSION_KEY_ABI,
    functionName: 'isSessionKeyValid',
    args:         [params.keyId],
  }) as Promise<boolean>;
}

// Revokes a session key — called when a user explicitly opts out of DeFi
// or when a key's validity window expires and needs to be cleaned up.
export async function revokeSessionKey(params: {
  smartAccountAddress: `0x${string}`;
  keyId:               `0x${string}`;
  chain?:              SupportedEvmChain;
}): Promise<`0x${string}`> {
  const client = getWalletClient(params.chain);

  return client.writeContract({
    address:      params.smartAccountAddress,
    abi:          SESSION_KEY_ABI,
    functionName: 'revokeSessionKey',
    args:         [params.keyId],
  });
}