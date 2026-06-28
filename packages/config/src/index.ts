// Env validators — each service imports and calls its own
export { loadWorkspaceEnv }         from './load-workspace-env';
export { validateSharedEnv }       from './env/shared.env';
export { validateGatewayEnv }      from './env/gateway.env';
export { validateRideEnv }         from './env/ride.env';
export { validatePaymentEnv }      from './env/payment.env';
export { validateNotificationEnv } from './env/notification.env';
export { validateGroupRideEnv }    from './env/group-ride.env';
export { validateWhatsappEnv }     from './env/whatsapp.env';

// Env types
export type { SharedEnv }       from './env/shared.env';
export type { GatewayEnv }      from './env/gateway.env';
export type { RideEnv }         from './env/ride.env';
export type { PaymentEnv }      from './env/payment.env';
export type { NotificationEnv } from './env/notification.env';
export type { GroupRideEnv }    from './env/group-ride.env';
export type { WhatsappEnv }     from './env/whatsapp.env';

// Constants
export { FEES }                        from './constants/fees';
export { GPS }                         from './constants/gps';
export { RIDE }                        from './constants/ride';
export {
  RATE_PER_KM_NGN,
  MIN_OFFER_DISCOUNT,
  FARE_ROUNDING_INCREMENT,
  calculateSuggestedFare,
  validateRiderOffer,
} from './pricing';
export type { SuggestedFare, RidePriceBreakdown } from './pricing';
export {
  GoogleMapsRoutePlanner,
  RoutePlanningError,
  estimateRideFareNgn,
} from './routing';
export type {
  PlannedRouteGeometry,
  PlannedRouteMetrics,
  RouteBounds,
  RouteWaypoint,
} from './routing';
