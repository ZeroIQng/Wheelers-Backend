import { calculateRidePrice, type RidePriceBreakdown } from '@wheleers/config';

export const RIDE_PRICING_CURRENCY = 'NGN' as const;

export type RideEstimatePricingFields = {
  fareEstimateNgn: number | null;
  pricingCurrency: typeof RIDE_PRICING_CURRENCY | null;
  pricingBreakdown: RidePriceBreakdown | null;
};

export function buildRideEstimatePricing(
  distanceKm: number | null | undefined,
): RideEstimatePricingFields {
  if (distanceKm === null || distanceKm === undefined || !Number.isFinite(distanceKm)) {
    return {
      fareEstimateNgn: null,
      pricingCurrency: null,
      pricingBreakdown: null,
    };
  }

  const pricingBreakdown = calculateRidePrice(distanceKm);

  return {
    fareEstimateNgn: pricingBreakdown.tripPrice,
    pricingCurrency: RIDE_PRICING_CURRENCY,
    pricingBreakdown,
  };
}
