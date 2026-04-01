// Singleton client — import this if you ever need raw Prisma access
export { prisma } from './prisma';

// Scoped clients — import only the one your service owns
export { userClient }       from './clients/user.client';
export { driverClient }     from './clients/driver.client';
export { rideClient }       from './clients/ride.client';
export { paymentClient }    from './clients/payment.client';
export { walletClient }     from './clients/wallet.client';
export { complianceClient } from './clients/compliance.client';
export { defiClient }       from './clients/defi.client';

// Re-export Prisma types so services don't need to install @prisma/client directly
export type {
  User,
  Driver,
  Ride,
  Wallet,
  VirtualAccount,
  Transaction,
  GpsLog,
  Recording,
  Dispute,
  Feedback,
  DefiPosition,
  YieldHarvest,
  UserConsent,
  Notification,
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
} from '@prisma/client';