import { getPublicClient }      from '../evm.client';
import { type SupportedEvmChain } from '../chains/evm.config';

// Estimates gas for a contract call and adds a 20% buffer.
// The buffer prevents "out of gas" failures when the actual execution
// uses slightly more gas than estimated (common with state-changing calls).
export async function estimateGasWithBuffer(params: {
  to:      `0x${string}`;
  data:    `0x${string}`;
  value?:  bigint;
  chain?:  SupportedEvmChain;
}): Promise<bigint> {
  const client   = getPublicClient(params.chain);
  const estimate = await client.estimateGas({
    to:    params.to,
    data:  params.data,
    value: params.value,
  });

  // Add 20% buffer: estimate * 1.2
  return (estimate * 12n) / 10n;
}

// Returns the current gas price from the RPC node.
// Used by wallet-service to show the user an estimate before signing.
export async function getCurrentGasPrice(chain?: SupportedEvmChain): Promise<bigint> {
  const client = getPublicClient(chain);
  return client.getGasPrice();
}