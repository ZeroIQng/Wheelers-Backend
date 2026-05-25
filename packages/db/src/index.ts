// Singleton client — import this if you ever need raw Prisma access
export { prisma } from './prisma';

// Scoped clients — import only the one your service owns
export { userClient }       from './clients/user.client';
export { driverClient }     from './clients/driver.client';
export { rideClient }       from './clients/rider.client';
export { scheduledRideClient } from './clients/scheduled-ride.client';
export { outboxClient }     from './clients/outbox.client';
export { paymentClient }    from './clients/payment.client';
export { walletClient }     from './clients/wallet.client';
export { withdrawalClient } from './clients/withdrawal.client';
export { groupRideClient }  from './clients/group-ride.client';
export { complianceClient } from './clients/compliance.client';
export { defiClient }       from './clients/defi.client';
export { referralClient }   from './clients/referral.client';

// Re-export Prisma types so services don't need to install @prisma/client directly
export type {
  User,
  Driver,
  Ride,
  RideStop,
  ScheduledRide,
  Wallet,
  VirtualAccount,
  PaymentIntent,
  RideHold,
  Transaction,
  GpsLog,
  Recording,
  Dispute,
  Feedback,
  DefiPosition,
  YieldHarvest,
  UserConsent,
  Notification,
  NotificationDevice,
  WalletReservation,
  WithdrawalRequest,
  GroupRideMatchRequest,
  GroupRideFaceVerification,
  ReferralCode,
  Referral,
  ReferralCashback,
  ReferralCashbackUsage,
  ReferralCashbackUnlock,
  Prisma,
} from '@prisma/client';

export {
  UserRole,
  KycStatus,
  DriverStatus,
  RideStatus,
  CancelStage,
  TransactionDirection,
  TransactionType,
  DefiTier,
  DefiProtocol,
  DefiPositionStatus,
  DisputeStatus,
  DisputeResolution,
  ConsentType,
  NotificationCategory,
  PaymentIntentStatus,
  PaymentSessionType,
  WalletReservationKind,
  WalletReservationStatus,
  WithdrawalRequestStatus,
  GroupRideMatchRequestStatus,
  GroupRideFaceVerificationStatus,
  RideHoldStatus,
  RideStopStatus,
  RideStopType,
  ScheduledRideStatus,
  ScheduledRidePaymentMethod,
  ReferralStatus,
  ReferralCashbackType,
  ReferralCashbackStatus,
} from '@prisma/client';
