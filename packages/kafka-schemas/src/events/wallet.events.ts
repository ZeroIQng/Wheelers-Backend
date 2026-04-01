/**
 * Wallet-related events
 */

export interface WalletCreatedEvent {
  type: 'wallet.created';
  data: {
    walletId: string;
    userId: string;
    initialBalance: number;
    currency: string;
    createdAt: Date;
  };
}

export interface WalletFundedEvent {
  type: 'wallet.funded';
  data: {
    walletId: string;
    userId: string;
    amount: number;
    previousBalance: number;
    newBalance: number;
    fundedAt: Date;
    method: string;
  };
}

export interface WalletWithdrawnEvent {
  type: 'wallet.withdrawn';
  data: {
    walletId: string;
    userId: string;
    amount: number;
    previousBalance: number;
    newBalance: number;
    withdrawnAt: Date;
  };
}

export interface WalletTransferEvent {
  type: 'wallet.transferred';
  data: {
    fromWalletId: string;
    toWalletId: string;
    fromUserId: string;
    toUserId: string;
    amount: number;
    transferredAt: Date;
    reason?: string;
  };
}

export type WalletEvent =
  | WalletCreatedEvent
  | WalletFundedEvent
  | WalletWithdrawnEvent
  | WalletTransferEvent;
