/**
 * DeFi/Blockchain-related events
 */

export interface TokenMintedEvent {
  type: 'defi.token.minted';
  data: {
    tokenId: string;
    userId: string;
    amount: number;
    contractAddress: string;
    transactionHash: string;
    mintedAt: Date;
  };
}

export interface TokenBurnedEvent {
  type: 'defi.token.burned';
  data: {
    tokenId: string;
    userId: string;
    amount: number;
    contractAddress: string;
    transactionHash: string;
    burnedAt: Date;
  };
}

export interface RewardClaimedEvent {
  type: 'defi.reward.claimed';
  data: {
    rewardId: string;
    userId: string;
    amount: number;
    rewardType: 'ride_completion' | 'referral' | 'loyalty' | 'other';
    transactionHash: string;
    claimedAt: Date;
  };
}

export interface StakingInitiatedEvent {
  type: 'defi.staking.initiated';
  data: {
    stakingId: string;
    userId: string;
    amount: number;
    lockDuration: number; // in days
    apy: number;
    contractAddress: string;
    transactionHash: string;
    initiatedAt: Date;
  };
}

export interface StakingUnlockedEvent {
  type: 'defi.staking.unlocked';
  data: {
    stakingId: string;
    userId: string;
    principalAmount: number;
    rewardAmount: number;
    totalAmount: number;
    transactionHash: string;
    unlockedAt: Date;
  };
}

export type DefiEvent =
  | TokenMintedEvent
  | TokenBurnedEvent
  | RewardClaimedEvent
  | StakingInitiatedEvent
  | StakingUnlockedEvent;
