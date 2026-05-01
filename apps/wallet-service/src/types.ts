import type { walletClient } from '@wheleers/db';

export type WalletRepository = Pick<
  typeof walletClient,
  | 'create'
  | 'findByUserId'
  | 'findByAddress'
  | 'createRideHold'
  | 'adjustRideHold'
  | 'completeRideHold'
  | 'cancelRideHold'
  | 'credit'
  | 'debit'
  | 'moveToStaked'
>;
