/**
 * What an interstate trip costs, and what a rider is allowed to offer for it.
 *
 * Import-free on purpose. The rider app carries its own copy of these rules so
 * its price stepper stops where the server would refuse, and the only way to be
 * sure the two agree is to run both in the same test. Anything that pulls
 * Prisma in here makes that impossible.
 *
 * The app's copy is `lib/interstate-pricing.ts` in Wheelersapp. Change one,
 * change both — `__tests__/interstate-offer.test.mjs` fails loudly otherwise.
 */

/**
 * The least a rider may offer, as a fraction of the posted fare.
 *
 * Below this a bid is not a negotiation, it is noise, and every one of them
 * costs a driver the time to read and refuse it.
 */
const MIN_OFFER_FRACTION = 0.7;

/** The floor for a posted fare, rounded up to the nearest ₦100. */
export function minimumOfferNgn(listPriceNgn: number): number {
  if (!Number.isFinite(listPriceNgn) || listPriceNgn <= 0) return 0;
  return Math.ceil((listPriceNgn * MIN_OFFER_FRACTION) / 100) * 100;
}

/**
 * Does naming this price start a negotiation, or book the seat outright?
 *
 * Strictly below the posted fare is a bid: nothing is charged and no seat is
 * held until a driver accepts it.
 */
export function isBidBelowFare(offeredNgn: number, listPriceNgn: number): boolean {
  return Math.round(offeredNgn) < listPriceNgn;
}
