import type { WhatsappDriverOffer } from './driver-state';

const MAX_FLOW_LIST_ITEMS = 10;

export function buildRideOfferListData(
  offers: WhatsappDriverOffer[],
): Record<string, unknown> {
  const capped = offers.slice(0, MAX_FLOW_LIST_ITEMS);
  const offerItems = capped.map((offer, index) => ({
    id: `offer-${index}`,
    title: `₦${offer.riderOfferNgn.toLocaleString()} — ${offer.paymentMethod}`,
    description: `${offer.pickupAddress} → ${offer.destinationAddress}${offer.plannedDistanceKm ? ` | ${offer.plannedDistanceKm.toFixed(1)}km` : ''}`,
  }));

  const countLabel = offers.length > MAX_FLOW_LIST_ITEMS
    ? `Showing ${MAX_FLOW_LIST_ITEMS} of ${offers.length} requests`
    : `${offers.length} ride request${offers.length === 1 ? '' : 's'}`;

  return {
    offers: offerItems,
    offer_count: countLabel,
  };
}

export function buildNoOffersData(): Record<string, unknown> {
  return {
    offers: [],
    offer_count: 'No ride requests — stay online, new ones come in soon',
  };
}

export function buildRideOfferDetailData(
  offer: WhatsappDriverOffer,
  index: number,
): Record<string, unknown> {
  const etaMin = offer.plannedDurationSeconds
    ? `${Math.ceil(offer.plannedDurationSeconds / 60)} min`
    : 'N/A';

  return {
    pickup: offer.pickupAddress,
    destination: offer.destinationAddress,
    rider_offer: `₦${offer.riderOfferNgn.toLocaleString()}`,
    suggested_fare: `₦${offer.suggestedFareNgn.toLocaleString()}`,
    payment_method: offer.paymentMethod,
    distance: offer.plannedDistanceKm ? `${offer.plannedDistanceKm.toFixed(1)} km` : 'N/A',
    duration: etaMin,
    offer_id: `offer-${index}`,
    ride_id: offer.rideId,
    rider_id: offer.riderId,
  };
}

export function buildDriverCounterOfferData(
  offer: WhatsappDriverOffer,
  index: number,
): Record<string, unknown> {
  return {
    pickup: offer.pickupAddress,
    destination: offer.destinationAddress,
    rider_offer: `₦${offer.riderOfferNgn.toLocaleString()}`,
    suggested_fare: `₦${offer.suggestedFareNgn.toLocaleString()}`,
    offer_id: `offer-${index}`,
    ride_id: offer.rideId,
    rider_id: offer.riderId,
  };
}

export function buildDriverConfirmationData(
  pickupAddress: string,
  destinationAddress: string,
  fareNgn: number,
): Record<string, unknown> {
  return {
    message: `Ride accepted! Head to *${pickupAddress}*. Destination: ${destinationAddress}. Fare: ₦${fareNgn.toLocaleString()}`,
  };
}

export function buildDriverErrorData(message: string): Record<string, unknown> {
  return { message };
}
