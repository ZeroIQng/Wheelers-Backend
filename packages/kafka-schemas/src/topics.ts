/**
 * Topic name constants
 * Never hardcode strings in your code - always use these constants
 */

export const TOPICS = {
  // Ride events
  RIDE_REQUESTED: 'ride.requested',
  RIDE_ACCEPTED: 'ride.accepted',
  RIDE_STARTED: 'ride.started',
  RIDE_COMPLETED: 'ride.completed',
  RIDE_CANCELLED: 'ride.cancelled',

  // Payment events
  PAYMENT_INITIATED: 'payment.initiated',
  PAYMENT_PROCESSED: 'payment.processed',
  PAYMENT_FAILED: 'payment.failed',
  PAYMENT_REFUNDED: 'payment.refunded',

  // Wallet events
  WALLET_CREATED: 'wallet.created',
  WALLET_FUNDED: 'wallet.funded',
  WALLET_WITHDRAWN: 'wallet.withdrawn',
  WALLET_TRANSFERRED: 'wallet.transferred',

  // GPS events
  GPS_LOCATION_UPDATED: 'gps.location.updated',
  GPS_ROUTE_PLANNED: 'gps.route.planned',
  GPS_DEVIATION_DETECTED: 'gps.deviation.detected',

  // DeFi events
  DEFI_TOKEN_MINTED: 'defi.token.minted',
  DEFI_TOKEN_BURNED: 'defi.token.burned',
  DEFI_REWARD_CLAIMED: 'defi.reward.claimed',
  DEFI_STAKING_INITIATED: 'defi.staking.initiated',
  DEFI_STAKING_UNLOCKED: 'defi.staking.unlocked',

  // Compliance events
  COMPLIANCE_KYC_INITIATED: 'compliance.kyc.initiated',
  COMPLIANCE_KYC_COMPLETED: 'compliance.kyc.completed',
  COMPLIANCE_DOCUMENT_VERIFIED: 'compliance.document.verified',
  COMPLIANCE_FRAUD_DETECTED: 'compliance.fraud.detected',
  COMPLIANCE_ACCOUNT_SUSPENDED: 'compliance.account.suspended',
  COMPLIANCE_REPORT_GENERATED: 'compliance.report.generated',
} as const;

export type TopicType = typeof TOPICS[keyof typeof TOPICS];
