export const RATE_PER_KM_NGN = 300;
export const PLATFORM_FEE_NGN = 0;
export const MIN_OFFER_DISCOUNT = 0.28;
export const FARE_ROUNDING_INCREMENT = 100;
export const VAT_RATE = 0.075; // 7.5% VAT
export const LAGOS_STATE_FEE_NGN = 30; // ₦30 flat per ride

export type SuggestedFare = {
  distanceKm: number;
  suggestedFareNgn: number;
  minOfferNgn: number;
  ratePerKmNgn: number;
};

export type RidePriceBreakdown = {
  distanceKm: number;
  suggestedFareNgn: number;
  minOfferNgn: number;
  ratePerKmNgn: number;
};

export function calculateSuggestedFare(distanceKm: number): SuggestedFare {
  if (!Number.isFinite(distanceKm) || distanceKm < 0) {
    throw new TypeError('distanceKm must be a finite number >= 0');
  }

  const rawFare = RATE_PER_KM_NGN * distanceKm + PLATFORM_FEE_NGN;
  const suggestedFareNgn = roundUpToIncrement(rawFare, FARE_ROUNDING_INCREMENT);
  const minOfferNgn = round2(suggestedFareNgn * (1 - MIN_OFFER_DISCOUNT));

  return {
    distanceKm,
    suggestedFareNgn,
    minOfferNgn,
    ratePerKmNgn: RATE_PER_KM_NGN,
  };
}

export function validateRiderOffer(
  offerNgn: number,
  suggestedFareNgn: number,
): { valid: boolean; minOfferNgn: number; reason?: string } {
  const minOfferNgn = round2(suggestedFareNgn * (1 - MIN_OFFER_DISCOUNT));

  if (!Number.isFinite(offerNgn) || offerNgn <= 0) {
    return { valid: false, minOfferNgn, reason: 'Offer must be a positive number.' };
  }

  if (offerNgn < minOfferNgn) {
    return {
      valid: false,
      minOfferNgn,
      reason: `Minimum offer is ${minOfferNgn} NGN (${Math.round((1 - MIN_OFFER_DISCOUNT) * 100)}% of suggested fare).`,
    };
  }

  return { valid: true, minOfferNgn };
}

export type RideFeeBreakdown = {
  fareNgn: number;
  vatNgn: number;
  stateLevyNgn: number;
  totalNgn: number;
};

export function calculateRideFees(fareNgn: number): RideFeeBreakdown {
  const vatNgn = round2(fareNgn * VAT_RATE);
  const stateLevyNgn = LAGOS_STATE_FEE_NGN;
  const totalNgn = round2(fareNgn + vatNgn + stateLevyNgn);
  return { fareNgn, vatNgn, stateLevyNgn, totalNgn };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function roundUpToIncrement(value: number, increment: number): number {
  return Math.ceil(value / increment) * increment;
}
