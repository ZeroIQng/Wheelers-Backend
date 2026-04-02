export const GPS = {
  // Driver is considered "stopped" if they haven't moved more than this
  // distance in STALE_TIME_WINDOW_MINUTES during an active ride.
  STALE_MOVEMENT_THRESHOLD_METRES: 50,
  STALE_TIME_WINDOW_MINUTES:       5,

  // How often the GPS stale check cron runs (seconds).
  STALE_CHECK_INTERVAL_SECONDS: 30,

  // Driver is considered "arrived" at pickup when within this radius.
  ARRIVED_RADIUS_METRES: 50,

  // How often the driver app should send GPS pings during a ride (seconds).
  // This is advisory — enforced client-side.
  DRIVER_PING_INTERVAL_SECONDS: 3,

  // How often ride-service writes a GPS snapshot to the DB for dispute evidence.
  // GPS_UPDATE events come every 3s but we only persist every 30s.
  DB_SNAPSHOT_INTERVAL_SECONDS: 30,
} as const;