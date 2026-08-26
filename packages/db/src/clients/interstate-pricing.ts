/**
 * What an interstate trip costs, what vehicle you can take, and what a rider is
 * allowed to offer for it.
 *
 * Import-free on purpose. The rider app carries its own copy of every rule in
 * here so the prices it shows and the floor its stepper stops at match what the
 * server will actually accept. The only way to be sure the two agree is to run
 * both in one test — anything that pulls Prisma in here makes that impossible.
 *
 * The app's copy is `lib/interstate-pricing.ts` in Wheelersapp. Change one,
 * change both: `__tests__/interstate-offer.test.mjs` fails loudly otherwise.
 */

/**
 * The rate the whole business is quoted from: ₦450 for every kilometre the
 * vehicle travels.
 *
 * This prices the *vehicle*, not the seat. A seat is this divided by how many
 * people are in the vehicle, which is why sharing is cheaper than going alone
 * and why a bus seat costs a fraction of a sedan seat over the same road.
 */
export const RATE_PER_KM_NGN = 450;

export type InterstateVehicleType = 'SEDAN' | 'SUV' | 'MINIBUS' | 'BUS';

export type VehicleClass = {
  type: InterstateVehicleType;
  label: string;
  /** What a rider needs to know to choose between them. */
  description: string;
  seats: number;
  /**
   * Multiplier on the base rate.
   *
   * A bigger vehicle costs more to run per kilometre — fuel, tyres, a driver
   * with a higher licence class — so the whole-vehicle price rises with size
   * even though the price *per seat* falls.
   */
  rateMultiplier: number;
};

/**
 * The cars a rider can pick between, cheapest vehicle first.
 *
 * `rateMultiplier` is the one number here that is a business judgement rather
 * than arithmetic: the ₦450/km rate is quoted for a sedan, and everything
 * larger scales off it. Change these in one place and both apps follow.
 */
export const VEHICLE_CLASSES: VehicleClass[] = [
  {
    type: 'SEDAN',
    label: 'Sedan',
    description: 'A regular car. Cheapest way to travel alone or as a pair.',
    seats: 4,
    rateMultiplier: 1,
  },
  {
    type: 'SUV',
    label: 'SUV',
    description: 'More room and luggage space for the same road.',
    seats: 6,
    rateMultiplier: 1.4,
  },
  {
    type: 'MINIBUS',
    label: 'Minibus',
    description: 'Shared with other travellers. The usual way people go.',
    seats: 14,
    rateMultiplier: 2,
  },
  {
    type: 'BUS',
    label: 'Coach',
    description: 'Full-size bus. The cheapest seat on any long route.',
    seats: 30,
    rateMultiplier: 3.2,
  },
];

export function vehicleClass(type: InterstateVehicleType): VehicleClass {
  return VEHICLE_CLASSES.find((entry) => entry.type === type) ?? VEHICLE_CLASSES[0];
}

/** Prices are shown and charged in whole naira, rounded up to the nearest ₦50. */
function roundFare(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.ceil(value / 50) * 50;
}

/** What it costs to run this whole vehicle over this distance. */
export function vehiclePriceNgn(
  distanceKm: number,
  type: InterstateVehicleType,
): number {
  if (!Number.isFinite(distanceKm) || distanceKm <= 0) return 0;
  return roundFare(distanceKm * RATE_PER_KM_NGN * vehicleClass(type).rateMultiplier);
}

/**
 * What one seat costs on this vehicle.
 *
 * The vehicle price split across its seats. Rounded up per seat, so a full
 * vehicle always covers at least what the vehicle costs to run — rounding down
 * would sell a trip for less than the fuel.
 */
export function seatPriceNgn(
  distanceKm: number,
  type: InterstateVehicleType,
): number {
  const vehicle = vehicleClass(type);
  return roundFare(vehiclePriceNgn(distanceKm, type) / vehicle.seats);
}

/**
 * What a rider pays for what they asked for.
 *
 * Going alone means paying for the vehicle, however many seats are in it.
 * Travelling together means paying for the seats you take.
 */
export function priceForBooking(params: {
  distanceKm: number;
  vehicleType: InterstateVehicleType;
  mode: 'alone' | 'together';
  seats: number;
}): number {
  if (params.mode === 'alone') {
    return vehiclePriceNgn(params.distanceKm, params.vehicleType);
  }
  return seatPriceNgn(params.distanceKm, params.vehicleType) * Math.max(1, params.seats);
}

/* ── bidding ─────────────────────────────────────────────────────────────── */

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
