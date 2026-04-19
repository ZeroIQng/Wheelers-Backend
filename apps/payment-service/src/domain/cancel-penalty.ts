import { FEES } from '@wheleers/config';
import type { RideCancelledEvent } from '@wheleers/kafka-schemas';

export interface CancelPenaltyDecision {
  penaltyUsdt: number;
  reason: 'rider_cancel_after_match' | 'rider_cancel_en_route' | 'rider_cancel_active_trip' | 'no_show';
}

export function getCancelPenaltyDecision(
  event: RideCancelledEvent,
): CancelPenaltyDecision | null {
  switch (event.cancelStage) {
    case 'after_match':
      return {
        penaltyUsdt: FEES.CANCEL_PENALTY_AFTER_MATCH_USDT,
        reason: 'rider_cancel_after_match',
      };
    case 'driver_en_route':
      return {
        penaltyUsdt: FEES.CANCEL_PENALTY_EN_ROUTE_USDT,
        reason: 'rider_cancel_en_route',
      };
    case 'active_trip':
      return {
        penaltyUsdt: FEES.CANCEL_PENALTY_ACTIVE_TRIP_USDT,
        reason: 'rider_cancel_active_trip',
      };
    case 'before_match':
    default:
      return null;
  }
}
