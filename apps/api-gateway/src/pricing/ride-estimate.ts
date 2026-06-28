import { calculateSuggestedFare, type SuggestedFare } from '@wheleers/config';

export const RIDE_PRICING_CURRENCY = 'NGN' as const;

export type RideEstimatePricingFields = {
  fareEstimateNgn: number | null;
  suggestedFareNgn: number | null;
  minOfferNgn: number | null;
  ratePerKmNgn: number | null;
  pricingCurrency: typeof RIDE_PRICING_CURRENCY | null;
  pricingBreakdown: SuggestedFare | null;
};

export function buildRideEstimatePricing(
  distanceKm: number | null | undefined,
): RideEstimatePricingFields {
  if (distanceKm === null || distanceKm === undefined || !Number.isFinite(distanceKm)) {
    return {
      fareEstimateNgn: null,
      suggestedFareNgn: null,
      minOfferNgn: null,
      ratePerKmNgn: null,
      pricingCurrency: null,
      pricingBreakdown: null,
    };
  }

  const pricing = calculateSuggestedFare(distanceKm);

  return {
    fareEstimateNgn: pricing.suggestedFareNgn,
    suggestedFareNgn: pricing.suggestedFareNgn,
    minOfferNgn: pricing.minOfferNgn,
    ratePerKmNgn: pricing.ratePerKmNgn,
    pricingCurrency: RIDE_PRICING_CURRENCY,
    pricingBreakdown: pricing,
  };
}
