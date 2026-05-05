// Env validators — each service imports and calls its own
export { loadWorkspaceEnv }         from './load-workspace-env';
export { validateSharedEnv }       from './env/shared.env';
export { validateGatewayEnv }      from './env/gateway.env';
export { validateRideEnv }         from './env/ride.env';
export { validatePaymentEnv }      from './env/payment.env';
export { validateWalletEnv }       from './env/wallet.env';
export { validateComplianceEnv }   from './env/compliance.env';
export { validateDefiEnv }         from './env/defi.env';
export { validateNotificationEnv } from './env/notification.env';

// Env types
export type { SharedEnv }       from './env/shared.env';
export type { GatewayEnv }      from './env/gateway.env';
export type { RideEnv }         from './env/ride.env';
export type { PaymentEnv }      from './env/payment.env';
export type { WalletEnv }       from './env/wallet.env';
export type { ComplianceEnv }   from './env/compliance.env';
export type { DefiEnv }         from './env/defi.env';
export type { NotificationEnv } from './env/notification.env';

// Constants
export { FEES }                        from './constants/fees';
export { GPS }                         from './constants/gps';
export { RIDE }                        from './constants/ride';
export { DEFI }                        from './constants/defi';
export { CHAINS, DEFAULT_CHAIN, USDT_ADDRESSES, SUPPORTED_CHAIN_IDS } from './constants/chains';
export {
  BATTERY_CAPACITY_KWH,
  CAR_COST_NAIRA,
  DAILY_INSURANCE_NAIRA,
  DAILY_MAINTENANCE_NAIRA,
  DRIVER_SALARY_NAIRA_PER_MONTH,
  ELECTRICITY_COST_NAIRA_PER_KWH,
  MARGIN_PERCENT,
  MINIMUM_DAILY_DISTANCE_KM,
  RANGE_PER_CHARGE_KM,
  REPAYMENT_MONTHS,
  RIDE_PRICING_DEFAULTS,
  calculateRidePrice,
} from './pricing';
export type { RidePriceBreakdown, RidePricingParameters } from './pricing';
export {
  OpenRouteServiceClient,
  RoutePlanningError,
  estimateRideFareUsdt,
} from './routing';
export type {
  PlannedRouteGeometry,
  PlannedRouteMetrics,
  RouteBounds,
  RouteWaypoint,
} from './routing';
