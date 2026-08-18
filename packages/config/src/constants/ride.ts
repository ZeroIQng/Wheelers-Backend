export const RIDE = {
  // Default search radius when looking for nearby drivers.
  DEFAULT_MATCH_RADIUS_KM: 5,

  // How long a driver has to accept a ride request before ride-service
  // tries the next nearest driver.
  DRIVER_ACCEPT_TIMEOUT_SECONDS: 15,

  // How long a request keeps ringing on driver phones before it times out and
  // the rider is told nobody took it. This is the single source of truth —
  // it was hard-coded as three minutes in four separate places, which is far
  // too long to leave a rider staring at a spinner.
  BID_TIMEOUT_SECONDS: 30,

  // Maximum number of drivers to attempt before cancelling the ride
  // with a "no drivers available" reason.
  MAX_MATCH_ATTEMPTS: 5,

  // How long after RIDE_COMPLETED the rider has to submit a rating.
  RATING_WINDOW_HOURS: 24,

  // Maximum surge multiplier on fare estimates during high demand.
  MAX_SURGE_MULTIPLIER: 3.0,
} as const;
