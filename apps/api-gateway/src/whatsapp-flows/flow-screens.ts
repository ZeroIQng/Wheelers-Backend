import type { WhatsappRideMeta, WhatsappBid } from './bid-state';

const MAX_FLOW_LIST_ITEMS = 10;

export function buildBidListData(
  meta: WhatsappRideMeta,
  bids: WhatsappBid[],
): Record<string, unknown> {
  const capped = bids.slice(0, MAX_FLOW_LIST_ITEMS);
  const bidItems = capped.map((bid, index) => ({
    id: `bid-${index}`,
    title: `${bid.driverName} — ₦${bid.counterOfferNgn.toLocaleString()}`,
    description: `${bid.vehicleModel} | ${bid.driverRating.toFixed(1)}★ | ETA ${Math.ceil(bid.etaSeconds / 60)} min`,
  }));

  const countLabel = bids.length > MAX_FLOW_LIST_ITEMS
    ? `Showing ${MAX_FLOW_LIST_ITEMS} of ${bids.length} offers`
    : `${bids.length} offer${bids.length === 1 ? '' : 's'}`;

  return {
    route_summary: `${meta.pickupAddress} → ${meta.destinationAddress}`,
    offer_amount: `₦${meta.offerNgn.toLocaleString()}`,
    bids: bidItems,
    bid_count: countLabel,
  };
}

export function buildBidDetailData(bid: WhatsappBid, index: number): Record<string, unknown> {
  return {
    driver_name: bid.driverName,
    vehicle_info: `${bid.vehicleModel} (${bid.vehiclePlate})`,
    rating: `${bid.driverRating.toFixed(1)}★`,
    eta: `${Math.ceil(bid.etaSeconds / 60)} minutes`,
    offer_price: `₦${bid.counterOfferNgn.toLocaleString()}`,
    bid_id: `bid-${index}`,
  };
}

export function buildCounterOfferData(
  meta: WhatsappRideMeta,
  bid: WhatsappBid,
  bidIndex: number,
): Record<string, unknown> {
  return {
    current_offer: `₦${meta.offerNgn.toLocaleString()}`,
    suggested_fare: `₦${meta.suggestedFareNgn.toLocaleString()}`,
    driver_name: bid.driverName,
    driver_offer: `₦${bid.counterOfferNgn.toLocaleString()}`,
    bid_id: `bid-${bidIndex}`,
  };
}

export function buildConfirmationData(
  driverName: string,
  vehicleModel: string,
  etaSeconds: number,
  fareNgn: number,
): Record<string, unknown> {
  return {
    message: `${driverName} is on the way in a ${vehicleModel}! ETA: ${Math.ceil(etaSeconds / 60)} min. Fare: ₦${fareNgn.toLocaleString()}`,
  };
}

export function buildNoBidsData(meta: WhatsappRideMeta): Record<string, unknown> {
  return {
    route_summary: `${meta.pickupAddress} → ${meta.destinationAddress}`,
    offer_amount: `₦${meta.offerNgn.toLocaleString()}`,
    bids: [],
    bid_count: 'No offers yet — check back shortly',
  };
}

export function buildErrorData(message: string): Record<string, unknown> {
  return {
    message,
  };
}
