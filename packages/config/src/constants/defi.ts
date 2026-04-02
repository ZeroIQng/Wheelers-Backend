export const DEFI = {
  // Minimum idle balance to qualify for each tier.
  TIER1_MIN_USDT: 5,    // Aave / Compound — auto-enrolled
  TIER2_MIN_USDT: 50,   // LP positions — opt-in recommended
  TIER3_MIN_USDT: 200,  // Staking — explicit opt-in only

  // Withdrawal timelines per tier.
  // Tier 1 is always immediate — funds exit for any ride payment.
  TIER2_WITHDRAWAL_HOURS: 48,
  TIER3_WITHDRAWAL_HOURS: 168,  // 7 days

  // How long before a ride debit is expected to trigger an unstake.
  // defi-scheduler starts unstaking UNSTAKE_LEAD_MINUTES before the funds
  // are actually needed, so Tier 1 funds are ready in time.
  UNSTAKE_LEAD_MINUTES: 2,

  // APY ranges (informational — actual APY comes from the protocol).
  TIER1_EXPECTED_APY_PCT: { min: 3,  max: 6  },
  TIER2_EXPECTED_APY_PCT: { min: 6,  max: 12 },
  TIER3_EXPECTED_APY_PCT: { min: 12, max: 20 },
} as const;