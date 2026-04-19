import { FEES } from '@wheleers/config';
import type { RideCompletedEvent } from '@wheleers/kafka-schemas';

export interface DriverPayoutBreakdown {
  grossFareUsdt: number;
  driverCostsUsdt: number;
  driverProfitUsdt: number;
  platformFeeUsdt: number;
  netPayoutUsdt: number;
  feeApplied: boolean;
}

export function calculateDriverPayout(
  event: RideCompletedEvent,
): DriverPayoutBreakdown {
  const grossFareUsdt = Math.max(0, event.fareUsdt);
  const driverCostsUsdt = 0;
  const driverProfitUsdt = Math.max(0, grossFareUsdt - driverCostsUsdt);
  const platformFeeUsdt =
    driverProfitUsdt > 0 ? round2(driverProfitUsdt * FEES.PLATFORM_FEE_PERCENT) : 0;
  const netPayoutUsdt = round2(driverProfitUsdt - platformFeeUsdt);

  return {
    grossFareUsdt,
    driverCostsUsdt,
    driverProfitUsdt,
    platformFeeUsdt,
    netPayoutUsdt,
    feeApplied: platformFeeUsdt > 0,
  };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
