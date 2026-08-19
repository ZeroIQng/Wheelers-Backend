export const RIDE = {
  // Default search radius when looking for nearby drivers.
  DEFAULT_MATCH_RADIUS_KM: 5,

  // How long a driver has to accept a ride request before ride-service
  // tries the next nearest driver.
  DRIVER_ACCEPT_TIMEOUT_SECONDS: 15,

  // How long one offer keeps ringing on a driver's phone — the countdown on
  // the request card.
  OFFER_TTL_SECONDS: 30,

  // How long the whole search runs before the rider is told nobody took it.
  // This MUST be much longer than OFFER_TTL_SECONDS. They were briefly the
  // same 30s constant, which meant the entire search was abandoned after one
  // offer window: the rider got "No driver accepted this ride request" while
  // a driver was still reading the request, and any bid arriving after that
  // had nothing left to attach to.
  BID_TIMEOUT_SECONDS: 180,

  // Maximum number of drivers to attempt before cancelling the ride
  // with a "no drivers available" reason.
  MAX_MATCH_ATTEMPTS: 5,

  // How long after RIDE_COMPLETED the rider has to submit a rating.
  RATING_WINDOW_HOURS: 24,

  // Maximum surge multiplier on fare estimates during high demand.
  MAX_SURGE_MULTIPLIER: 3.0,
} as const;
