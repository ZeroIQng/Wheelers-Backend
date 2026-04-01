import { z } from 'zod';

// Fired by ride-service GPS monitor cron (checks every 30s).
// Condition: active ride, driver hasn't moved >50m in last 5 minutes.
// Consumed by: notification-worker (push warning to driver),
// api-gateway (show alert on rider screen).
export const GpsStaleWarningEvent = z.object({
  eventType:        z.literal('GPS_STALE_WARNING'),
  rideId:           z.string().uuid(),
  driverId:         z.string().uuid(),
  riderId:          z.string().uuid(),
  lastMovementAt:   z.string().datetime(),
  staleMinutes:     z.number(),
  lastKnownLat:     z.number(),
  lastKnownLng:     z.number(),
  timestamp:        z.string().datetime(),
});

// Fired by api-gateway when rider or driver submits post-ride rating.
// Consumed by: compliance-worker (log rating on-chain, update driver rating average),
// notification-worker (no push — silent).
export const FeedbackLoggedEvent = z.object({
  eventType:       z.literal('FEEDBACK_LOGGED'),
  feedbackId:      z.string().uuid(),
  rideId:          z.string().uuid(),
  reviewerId:      z.string().uuid(),
  reviewerRole:    z.enum(['rider', 'driver']),
  revieweeId:      z.string().uuid(),
  revieweeWallet:  z.string(),
  rating:          z.number().min(1).max(5),
  comment:         z.string().max(500).optional(),
  commentHash:     z.string().optional(), // SHA-256 of comment for on-chain log
  onchainTxHash:   z.string().optional(), // set after compliance-worker logs it
  timestamp:       z.string().datetime(),
});

// Fired by api-gateway when rider or driver opens a dispute.
// Consumed by: compliance-worker (fetch recording CID, alert admin dashboard),
// notification-worker (push "dispute opened" to both parties),
// ride-service (freeze any pending payouts until resolved).
export const DisputeOpenedEvent = z.object({
  eventType:     z.literal('DISPUTE_OPENED'),
  disputeId:     z.string().uuid(),
  rideId:        z.string().uuid(),
  openedBy:      z.string().uuid(),
  openedByRole:  z.enum(['rider', 'driver']),
  againstId:     z.string().uuid(),
  reason:        z.string().max(1000),
  recordingCid:  z.string().optional(), // if ride was recorded
  timestamp:     z.string().datetime(),
});

// Fired by compliance-worker (admin) after reviewing a dispute.
// Consumed by: payment-service (release or redirect funds per resolution),
// wallet-service (unlock held funds), notification-worker (push outcome to both).
export const DisputeResolvedEvent = z.object({
  eventType:      z.literal('DISPUTE_RESOLVED'),
  disputeId:      z.string().uuid(),
  rideId:         z.string().uuid(),
  resolution:     z.enum(['favour_rider', 'favour_driver', 'split', 'no_action']),
  notes:          z.string().optional(),
  resolvedBy:     z.string(), // admin user ID
  refundUsdt:     z.number().optional(), // set if rider gets refund
  bonusUsdt:      z.number().optional(), // set if driver gets bonus
  timestamp:      z.string().datetime(),
});

// Fired by compliance-worker after recording is encrypted and stored on IPFS.
// Consumed by: api-gateway (link recording to ride in DB),
// compliance-worker itself (log SHA-256 hash on-chain — separate tx).
export const RecordingStoredEvent = z.object({
  eventType:       z.literal('RECORDING_STORED'),
  recordingId:     z.string().uuid(),
  rideId:          z.string().uuid(),
  ipfsCid:         z.string(),       // content ID on IPFS
  sha256Hash:      z.string(),       // hash of the encrypted file (logged on-chain)
  consentTxHash:   z.string(),       // on-chain consent that authorised this recording
  durationSeconds: z.number().int(),
  encryptedWith:   z.string(),       // key derivation scheme identifier e.g. "aes256-gcm-v1"
  timestamp:       z.string().datetime(),
});

export const ComplianceEvent = z.discriminatedUnion('eventType', [
  GpsStaleWarningEvent,
  FeedbackLoggedEvent,
  DisputeOpenedEvent,
  DisputeResolvedEvent,
  RecordingStoredEvent,
]);

export type GpsStaleWarningEvent = z.infer<typeof GpsStaleWarningEvent>;
export type FeedbackLoggedEvent  = z.infer<typeof FeedbackLoggedEvent>;
export type DisputeOpenedEvent   = z.infer<typeof DisputeOpenedEvent>;
export type DisputeResolvedEvent = z.infer<typeof DisputeResolvedEvent>;
export type RecordingStoredEvent = z.infer<typeof RecordingStoredEvent>;
export type ComplianceEvent      = z.infer<typeof ComplianceEvent>;