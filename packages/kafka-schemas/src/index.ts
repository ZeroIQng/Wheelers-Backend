/**
 * Single export point for kafka-schemas package
 */

// Export all event types
export type {
  RideRequestedEvent,
  RideAcceptedEvent,
  RideStartedEvent,
  RideCompletedEvent,
  RideCancelledEvent,
  RideEvent,
} from './events/ride.events';

export type {
  PaymentInitiatedEvent,
  PaymentProcessedEvent,
  PaymentFailedEvent,
  PaymentRefundedEvent,
  PaymentEvent,
} from './events/payment.events';

export type {
  WalletCreatedEvent,
  WalletFundedEvent,
  WalletWithdrawnEvent,
  WalletTransferEvent,
  WalletEvent,
} from './events/wallet.events';

export type {
  LocationUpdatedEvent,
  RoutePlannedEvent,
  DeviationDetectedEvent,
  GPSEvent,
} from './events/gps.events';

export type {
  TokenMintedEvent,
  TokenBurnedEvent,
  RewardClaimedEvent,
  StakingInitiatedEvent,
  StakingUnlockedEvent,
  DefiEvent,
} from './events/defi.events';

export type {
  KycInitiatedEvent,
  KycCompletedEvent,
  DocumentVerifiedEvent,
  FraudDetectedEvent,
  AccountSuspendedEvent,
  ComplianceReportGeneratedEvent,
  ComplianceEvent,
} from './events/compliance.events';

// Export topic constants
// export { TOPICS, type TopicType } from './topics';

// Export registry and type guards
export {
  type AllEvents,
  isRideEvent,
  isPaymentEvent,
  isWalletEvent,
  isGPSEvent,
  isDefiEvent,
  isComplianceEvent,
} from './registry';
