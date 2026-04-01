import { z } from 'zod';

const BaseDefiEvent = z.object({
  userId:        z.string().uuid(),
  walletAddress: z.string(),
  timestamp:     z.string().datetime(),
});

// Fired by defi-scheduler cron job (runs every hour).
// Logic: if wallet balance has been above IDLE_THRESHOLD_USDT for IDLE_HOURS
// and no ride has been requested recently, emit this event.
// Consumed by: wallet-service (auto-stake at recommendedTier if user opted in),
// notification-worker (nudge notification if user hasn't opted in).
export const IdleFundsDetectedEvent = BaseDefiEvent.extend({
  eventType:          z.literal('IDLE_FUNDS_DETECTED'),
  idleBalanceUsdt:    z.number(),
  idleSinceHours:     z.number(),
  recommendedTier:    z.enum(['tier1', 'tier2', 'tier3']),
  userOptedIn:        z.boolean(), // true = auto-stake, false = just nudge
});

// Fired by wallet-service after successfully executing the stake transaction.
// Consumed by: compliance-worker (log position on-chain),
// notification-worker (push "earning yield" confirmation to rider).
export const DefiStakedEvent = BaseDefiEvent.extend({
  eventType:           z.literal('DEFI_STAKED'),
  positionId:          z.string().uuid(),
  amountUsdt:          z.number(),
  protocol:            z.enum(['aave', 'compound', 'curve', 'uniswap_lp']),
  tier:                z.enum(['tier1', 'tier2', 'tier3']),
  txHash:              z.string(),
  chainId:             z.number().int(),
  expectedApyPercent:  z.number(),
});

// Fired by defi-scheduler when a rider requests a ride but has staked funds.
// Also fired by user explicitly withdrawing via app.
// urgency=immediate means the rider needs funds NOW for a ride —
// wallet-service must use the fastest exit path available for the protocol.
// Consumed by: wallet-service (execute unstake transaction).
export const DefiUnstakeRequestedEvent = BaseDefiEvent.extend({
  eventType:   z.literal('DEFI_UNSTAKE_REQUESTED'),
  positionId:  z.string().uuid(),
  amountUsdt:  z.number(),
  reason:      z.enum(['ride_requested', 'user_withdrawal', 'tier_change', 'emergency']),
  rideId:      z.string().uuid().optional(), // set when reason=ride_requested
  urgency:     z.enum(['immediate', 'standard']),
});

// Fired by wallet-service after unstake completes and funds are returned.
// Consumed by: notification-worker (push "funds available" to rider),
// api-gateway (push balance update to WebSocket).
export const DefiUnstakedEvent = BaseDefiEvent.extend({
  eventType:      z.literal('DEFI_UNSTAKED'),
  positionId:     z.string().uuid(),
  amountUsdt:     z.number(),
  txHash:         z.string(),
  reason:         z.enum(['ride_requested', 'user_withdrawal', 'tier_change', 'emergency']),
});

// Fired by defi-scheduler when yield is harvested from a protocol.
// Consumed by: wallet-service (credit harvested yield to wallet),
// compliance-worker (log yield event on-chain),
// notification-worker (push earnings summary).
export const YieldHarvestedEvent = BaseDefiEvent.extend({
  eventType:          z.literal('YIELD_HARVESTED'),
  positionId:         z.string().uuid(),
  yieldAmountUsdt:    z.number(),
  protocol:           z.string(),
  tier:               z.enum(['tier1', 'tier2', 'tier3']),
  apyActualPercent:   z.number(),
  periodDays:         z.number(),
  txHash:             z.string(),
  chainId:            z.number().int(),
});

export const DefiEvent = z.discriminatedUnion('eventType', [
  IdleFundsDetectedEvent,
  DefiStakedEvent,
  DefiUnstakeRequestedEvent,
  DefiUnstakedEvent,
  YieldHarvestedEvent,
]);

export type IdleFundsDetectedEvent    = z.infer<typeof IdleFundsDetectedEvent>;
export type DefiStakedEvent           = z.infer<typeof DefiStakedEvent>;
export type DefiUnstakeRequestedEvent = z.infer<typeof DefiUnstakeRequestedEvent>;
export type DefiUnstakedEvent         = z.infer<typeof DefiUnstakedEvent>;
export type YieldHarvestedEvent       = z.infer<typeof YieldHarvestedEvent>;
export type DefiEvent                 = z.infer<typeof DefiEvent>;