export const CAR_COST_NAIRA = 12_000_000;
export const REPAYMENT_MONTHS = 12;
export const DRIVER_SALARY_NAIRA_PER_MONTH = 200_000;
export const DAILY_INSURANCE_NAIRA = 2_000;
export const DAILY_MAINTENANCE_NAIRA = 3_333;
export const BATTERY_CAPACITY_KWH = 39.826;
export const RANGE_PER_CHARGE_KM = 400;
export const ELECTRICITY_COST_NAIRA_PER_KWH = 500;
export const MINIMUM_DAILY_DISTANCE_KM = 200;
export const MARGIN_PERCENT = 25;
export const FARE_ROUNDING_INCREMENT_NAIRA = 100;

export type RidePricingParameters = {
  carCostNaira: number;
  repaymentMonths: number;
  driverSalaryNairaPerMonth: number;
  dailyInsuranceNaira: number;
  dailyMaintenanceNaira: number;
  batteryCapacityKwh: number;
  rangePerChargeKm: number;
  electricityCostNairaPerKwh: number;
  minimumDailyDistanceKm: number;
  marginPercent: number;
  fareRoundingIncrementNaira: number;
};

export type RidePriceBreakdown = {
  distanceKm: number;
  tripPrice: number;
  tripProfit: number;
  energyCost: number;
  pricePerKm: number;
  breakEvenPerKm: number;
  profitPerKm: number;
};

export const RIDE_PRICING_DEFAULTS: RidePricingParameters = {
  carCostNaira: CAR_COST_NAIRA,
  repaymentMonths: REPAYMENT_MONTHS,
  driverSalaryNairaPerMonth: DRIVER_SALARY_NAIRA_PER_MONTH,
  dailyInsuranceNaira: DAILY_INSURANCE_NAIRA,
  dailyMaintenanceNaira: DAILY_MAINTENANCE_NAIRA,
  batteryCapacityKwh: BATTERY_CAPACITY_KWH,
  rangePerChargeKm: RANGE_PER_CHARGE_KM,
  electricityCostNairaPerKwh: ELECTRICITY_COST_NAIRA_PER_KWH,
  minimumDailyDistanceKm: MINIMUM_DAILY_DISTANCE_KM,
  marginPercent: MARGIN_PERCENT,
  fareRoundingIncrementNaira: FARE_ROUNDING_INCREMENT_NAIRA,
};

export function calculateRidePrice(
  distanceKm: number,
  overrides: Partial<RidePricingParameters> = {},
): RidePriceBreakdown {
  validateFiniteNonNegative(distanceKm, 'distanceKm');

  const params: RidePricingParameters = {
    ...RIDE_PRICING_DEFAULTS,
    ...overrides,
  };

  validatePositive(params.carCostNaira, 'carCostNaira');
  validatePositiveInteger(params.repaymentMonths, 'repaymentMonths');
  validatePositive(params.driverSalaryNairaPerMonth, 'driverSalaryNairaPerMonth');
  validatePositive(params.dailyInsuranceNaira, 'dailyInsuranceNaira');
  validatePositive(params.dailyMaintenanceNaira, 'dailyMaintenanceNaira');
  validatePositive(params.batteryCapacityKwh, 'batteryCapacityKwh');
  validatePositive(params.rangePerChargeKm, 'rangePerChargeKm');
  validatePositive(params.electricityCostNairaPerKwh, 'electricityCostNairaPerKwh');
  validatePositive(params.minimumDailyDistanceKm, 'minimumDailyDistanceKm');
  validateFiniteNonNegative(params.marginPercent, 'marginPercent');
  validatePositive(params.fareRoundingIncrementNaira, 'fareRoundingIncrementNaira');

  const energyPerKm = params.batteryCapacityKwh / params.rangePerChargeKm;
  const dailyEnergy =
    params.minimumDailyDistanceKm * energyPerKm * params.electricityCostNairaPerKwh;
  const dailyCarRecovery = params.carCostNaira / params.repaymentMonths / 30;
  const dailyDriverCost = params.driverSalaryNairaPerMonth / 30;
  const totalDailyCost =
    dailyCarRecovery +
    dailyDriverCost +
    params.dailyInsuranceNaira +
    params.dailyMaintenanceNaira +
    dailyEnergy;
  const breakEvenPerKm = totalDailyCost / params.minimumDailyDistanceKm;
  const pricePerKm = breakEvenPerKm * (1 + params.marginPercent / 100);
  const profitPerKm = pricePerKm - breakEvenPerKm;
  const rawTripPrice = pricePerKm * distanceKm;
  const roundedTripPrice = roundUpToIncrement(
    rawTripPrice,
    params.fareRoundingIncrementNaira,
  );
  const tripBreakEvenCost = breakEvenPerKm * distanceKm;

  return {
    distanceKm,
    tripPrice: round2(roundedTripPrice),
    tripProfit: round2(roundedTripPrice - tripBreakEvenCost),
    energyCost: round2(energyPerKm * distanceKm * params.electricityCostNairaPerKwh),
    pricePerKm: round2(pricePerKm),
    breakEvenPerKm: round2(breakEvenPerKm),
    profitPerKm: round2(profitPerKm),
  };
}

function validateFiniteNonNegative(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new TypeError(`${name} must be a finite number greater than or equal to 0`);
  }
}

function validatePositive(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${name} must be a finite number greater than 0`);
  }
}

function validatePositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive integer`);
  }
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function roundUpToIncrement(value: number, increment: number): number {
  return Math.ceil(value / increment) * increment;
}
