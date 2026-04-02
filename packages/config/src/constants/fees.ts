export const FEES = {
  // Platform fee: 0.3% of driver profit only.
  // If the driver makes no profit on a ride, this is 0.
  PLATFORM_FEE_PERCENT: 0.003,

  // Minimum ride fare — no ride settles below this.
  MIN_RIDE_FARE_USDT: 0.50,

  // Cancellation penalties by stage.
  // before_match: no penalty (driver hasn't been found yet).
  // after_match: small penalty — driver was found but not yet moving.
  // driver_en_route: medium penalty — driver is already on the way.
  // active_trip: highest penalty — trip already started.
  CANCEL_PENALTY_AFTER_MATCH_USDT:    0.20,
  CANCEL_PENALTY_EN_ROUTE_USDT:       0.50,
  CANCEL_PENALTY_ACTIVE_TRIP_USDT:    1.00,
} as const;