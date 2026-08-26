import { Prisma } from '@prisma/client';
import { prisma } from '../prisma';

/**
 * Interstate travel — Lagos → Ibadan, Abuja → Kaduna, and the rest.
 *
 * A city ride is matched to a driver in the moment; an interstate journey is
 * sold ahead of time out of a fixed pool of seats. That difference drives
 * everything here:
 *
 *  • Inventory is a *departure*, not a driver. Seats are the scarce thing.
 *  • Two ways to buy: SHARED (per seat, pooled with strangers) or CHARTER
 *    (the whole vehicle, which takes the departure off the shared market).
 *  • Prices are snapshotted onto the departure, so re-pricing a route never
 *    silently changes what someone already agreed to pay.
 *  • Seat allocation runs inside a transaction with a conditional update, so
 *    two riders buying the last seat at the same moment cannot both win.
 */

export type BookingMode = 'SHARED' | 'CHARTER';

/** Departures that still hold seats a rider could buy. */
const SELLABLE_STATUSES = ['SCHEDULED', 'FILLING'] as const;

/** How long before departure the doors close. */
const BOOKING_CUTOFF_MINUTES = 30;

export class InterstateError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'InterstateError';
  }
}

const money = (value: Prisma.Decimal | number | null | undefined): number =>
  value === null || value === undefined ? 0 : Number(value);

function bookingReference(): string {
  // Human-readable at a terminal desk: WHL-8F3K2Q
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < 6; i += 1) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return `WHL-${out}`;
}

/**
 * Refunds get less generous the closer you cancel to departure, because the
 * seat gets harder to resell. Expressed as the fraction returned to the rider.
 */
export function refundFractionFor(departureAt: Date, now = new Date()): number {
  const hoursUntil = (departureAt.getTime() - now.getTime()) / 3_600_000;
  if (hoursUntil >= 24) return 1;
  if (hoursUntil >= 6) return 0.75;
  if (hoursUntil >= 2) return 0.5;
  return 0;
}

export interface QuoteResult {
  routeId: string;
  origin: { state: string; city: string; terminal: string };
  destination: { state: string; city: string; terminal: string };
  distanceKm: number;
  durationMinutes: number;
  mode: BookingMode;
  seats: number;
  pricePerSeatNgn: number;
  totalNgn: number;
  /** What the same journey would cost the other way round, for comparison. */
  alternative: { mode: BookingMode; totalNgn: number; note: string };
}

export const interstateClient = {
  /* ── routes ─────────────────────────────────────────────────────────── */

  listRoutes: (options: { origin?: string; destination?: string; state?: string } = {}) =>
    prisma.interstateRoute.findMany({
      where: {
        active: true,
        ...(options.origin ? { originCity: { equals: options.origin, mode: 'insensitive' } } : {}),
        ...(options.destination ? { destCity: { equals: options.destination, mode: 'insensitive' } } : {}),
        ...(options.state ? { originState: { equals: options.state, mode: 'insensitive' } } : {}),
      },
      orderBy: [{ originCity: 'asc' }, { destCity: 'asc' }],
    }),

  findRoute: (routeId: string) => prisma.interstateRoute.findUnique({ where: { id: routeId } }),

  /** Distinct cities you can leave from — what a "where are you going?" list needs. */
  listOrigins: async () => {
    const rows = await prisma.interstateRoute.findMany({
      where: { active: true },
      select: { originState: true, originCity: true },
      distinct: ['originCity'],
      orderBy: { originCity: 'asc' },
    });
    return rows.map((r) => ({ state: r.originState, city: r.originCity }));
  },

  listDestinationsFrom: async (originCity: string) => {
    const rows = await prisma.interstateRoute.findMany({
      where: { active: true, originCity: { equals: originCity, mode: 'insensitive' } },
      select: {
        id: true, destState: true, destCity: true, destTerminal: true,
        distanceKm: true, durationMinutes: true, seatPriceNgn: true, charterPriceNgn: true,
      },
      orderBy: { destCity: 'asc' },
    });
    return rows.map((r) => ({
      routeId: r.id,
      state: r.destState,
      city: r.destCity,
      terminal: r.destTerminal,
      distanceKm: r.distanceKm,
      durationMinutes: r.durationMinutes,
      seatPriceNgn: money(r.seatPriceNgn),
      charterPriceNgn: money(r.charterPriceNgn),
    }));
  },

  /* ── quoting ────────────────────────────────────────────────────────── */

  quote: async (params: { routeId: string; mode: BookingMode; seats?: number }): Promise<QuoteResult> => {
    const route = await prisma.interstateRoute.findUnique({ where: { id: params.routeId } });
    if (!route || !route.active) {
      throw new InterstateError('That route is not available.', 'ROUTE_NOT_FOUND');
    }

    const seats = Math.max(1, params.seats ?? 1);
    const seatPrice = money(route.seatPriceNgn);
    const charterPrice = money(route.charterPriceNgn);
    const totalNgn = params.mode === 'CHARTER' ? charterPrice : seatPrice * seats;

    return {
      routeId: route.id,
      origin: { state: route.originState, city: route.originCity, terminal: route.originTerminal },
      destination: { state: route.destState, city: route.destCity, terminal: route.destTerminal },
      distanceKm: route.distanceKm,
      durationMinutes: route.durationMinutes,
      mode: params.mode,
      seats: params.mode === 'CHARTER' ? seats : seats,
      pricePerSeatNgn: params.mode === 'CHARTER' ? charterPrice : seatPrice,
      totalNgn,
      alternative:
        params.mode === 'CHARTER'
          ? {
              mode: 'SHARED',
              totalNgn: seatPrice * seats,
              note: `Sharing with other travellers costs ₦${(seatPrice * seats).toLocaleString('en-NG')} for ${seats} seat(s).`,
            }
          : {
              mode: 'CHARTER',
              totalNgn: charterPrice,
              note: `Chartering the whole vehicle costs ₦${charterPrice.toLocaleString('en-NG')}.`,
            },
    };
  },

  /* ── departures ─────────────────────────────────────────────────────── */

  /**
   * Shared departures a rider can still buy into, for a route and day.
   * Charter departures are excluded: they belong to whoever booked them.
   */
  searchDepartures: async (params: {
    routeId: string;
    from?: Date;
    to?: Date;
    seats?: number;
  }) => {
    const seats = Math.max(1, params.seats ?? 1);
    const from = params.from ?? new Date();
    const cutoff = new Date(Date.now() + BOOKING_CUTOFF_MINUTES * 60_000);
    const earliest = from > cutoff ? from : cutoff;

    const rows = await prisma.interstateDeparture.findMany({
      where: {
        routeId: params.routeId,
        bookingMode: 'SHARED',
        status: { in: [...SELLABLE_STATUSES] },
        departureAt: { gte: earliest, ...(params.to ? { lte: params.to } : {}) },
      },
      orderBy: { departureAt: 'asc' },
      take: 50,
      include: { route: true },
    });

    return rows
      .map((d) => ({
        id: d.id,
        departureAt: d.departureAt,
        vehicleType: d.vehicleType,
        totalSeats: d.totalSeats,
        seatsAvailable: d.totalSeats - d.seatsBooked,
        seatPriceNgn: money(d.seatPriceNgn),
        status: d.status,
        route: {
          id: d.route.id,
          origin: { city: d.route.originCity, state: d.route.originState, terminal: d.route.originTerminal },
          destination: { city: d.route.destCity, state: d.route.destState, terminal: d.route.destTerminal },
          distanceKm: d.route.distanceKm,
          durationMinutes: d.route.durationMinutes,
        },
      }))
      .filter((d) => d.seatsAvailable >= seats);
  },

  findDeparture: (departureId: string) =>
    prisma.interstateDeparture.findUnique({
      where: { id: departureId },
      include: { route: true, driver: { include: { user: true } } },
    }),

  /* ── booking ────────────────────────────────────────────────────────── */

  /**
   * Take seats on an existing shared departure.
   *
   * Runs in one transaction: the seat count is incremented with a conditional
   * `updateMany` that only matches while the seats are actually free, so the
   * loser of a race gets a clean "sold out" instead of an oversold vehicle.
   * `chargeWallet` is invoked inside the same transaction — if payment throws,
   * the seats are released with it.
   */
  bookSeats: async (params: {
    departureId: string;
    userId: string;
    seats: number;
    passengerName?: string;
    passengerPhone?: string;
    pickupNote?: string;
    /** Charges the rider. Anything thrown here rolls the seats back. */
    chargeWallet: (amountNgn: number, reference: string, tx: Prisma.TransactionClient) => Promise<void>;
  }) => {
    const seats = Math.max(1, Math.floor(params.seats));

    return prisma.$transaction(async (tx) => {
      const departure = await tx.interstateDeparture.findUnique({
        where: { id: params.departureId },
        include: { route: true },
      });
      if (!departure) {
        throw new InterstateError('That departure does not exist.', 'DEPARTURE_NOT_FOUND');
      }
      if (departure.bookingMode === 'CHARTER') {
        throw new InterstateError('That departure is a private charter and is not sold by the seat.', 'DEPARTURE_IS_CHARTER');
      }
      if (!SELLABLE_STATUSES.includes(departure.status as (typeof SELLABLE_STATUSES)[number])) {
        throw new InterstateError(
          `This trip is no longer taking bookings (${departure.status.toLowerCase()}).`,
          'DEPARTURE_CLOSED',
          { status: departure.status },
        );
      }
      if (departure.departureAt.getTime() - Date.now() < BOOKING_CUTOFF_MINUTES * 60_000) {
        throw new InterstateError(
          `Bookings close ${BOOKING_CUTOFF_MINUTES} minutes before departure.`,
          'DEPARTURE_TOO_SOON',
          { departureAt: departure.departureAt.toISOString() },
        );
      }

      const seatsAvailable = departure.totalSeats - departure.seatsBooked;
      if (seatsAvailable < seats) {
        throw new InterstateError(
          seatsAvailable === 0
            ? 'This trip is fully booked.'
            : `Only ${seatsAvailable} seat(s) left on this trip.`,
          'NOT_ENOUGH_SEATS',
          { seatsAvailable },
        );
      }

      // Conditional: only succeeds while the seats are still genuinely free.
      const claimed = await tx.interstateDeparture.updateMany({
        where: {
          id: departure.id,
          status: { in: [...SELLABLE_STATUSES] },
          seatsBooked: { lte: departure.totalSeats - seats },
        },
        data: { seatsBooked: { increment: seats } },
      });
      if (claimed.count === 0) {
        throw new InterstateError('Those seats were just taken. Try another departure.', 'SEATS_TAKEN');
      }

      const amountNgn = money(departure.seatPriceNgn) * seats;
      const reference = bookingReference();

      await params.chargeWallet(amountNgn, reference, tx);

      const booking = await tx.interstateBooking.create({
        data: {
          departureId: departure.id,
          userId: params.userId,
          mode: 'SHARED',
          seats,
          amountNgn,
          status: 'CONFIRMED',
          passengerName: params.passengerName ?? null,
          passengerPhone: params.passengerPhone ?? null,
          pickupNote: params.pickupNote ?? null,
          reference,
        },
      });

      // Keep the departure's own status honest about how full it is.
      const nowBooked = departure.seatsBooked + seats;
      const nextStatus = nowBooked >= departure.totalSeats ? 'FULL' : 'FILLING';
      await tx.interstateDeparture.update({
        where: { id: departure.id },
        data: { status: nextStatus },
      });

      return { booking, departure, route: departure.route, seatsRemaining: departure.totalSeats - nowBooked };
    });
  },

  /**
   * Charter a whole vehicle: creates a departure reserved to this booking, so
   * it never appears in shared search results.
   */
  charter: async (params: {
    routeId: string;
    userId: string;
    departureAt: Date;
    vehicleType?: 'SEDAN' | 'SUV' | 'MINIBUS' | 'BUS';
    passengerName?: string;
    passengerPhone?: string;
    pickupNote?: string;
    chargeWallet: (amountNgn: number, reference: string, tx: Prisma.TransactionClient) => Promise<void>;
  }) => {
    if (params.departureAt.getTime() - Date.now() < BOOKING_CUTOFF_MINUTES * 60_000) {
      throw new InterstateError(
        `Charters must be booked at least ${BOOKING_CUTOFF_MINUTES} minutes ahead.`,
        'DEPARTURE_TOO_SOON',
      );
    }

    return prisma.$transaction(async (tx) => {
      const route = await tx.interstateRoute.findUnique({ where: { id: params.routeId } });
      if (!route || !route.active) {
        throw new InterstateError('That route is not available.', 'ROUTE_NOT_FOUND');
      }

      const vehicleType = params.vehicleType ?? 'SUV';
      const capacity = { SEDAN: 4, SUV: 6, MINIBUS: 14, BUS: 30 }[vehicleType];
      const amountNgn = money(route.charterPriceNgn);
      const reference = bookingReference();

      const departure = await tx.interstateDeparture.create({
        data: {
          routeId: route.id,
          departureAt: params.departureAt,
          vehicleType,
          totalSeats: capacity,
          seatsBooked: capacity, // the whole vehicle belongs to this booking
          seatPriceNgn: route.seatPriceNgn,
          charterPriceNgn: route.charterPriceNgn,
          bookingMode: 'CHARTER',
          minimumSeats: 1,
          status: 'FULL',
        },
      });

      await params.chargeWallet(amountNgn, reference, tx);

      const booking = await tx.interstateBooking.create({
        data: {
          departureId: departure.id,
          userId: params.userId,
          mode: 'CHARTER',
          seats: capacity,
          amountNgn,
          status: 'CONFIRMED',
          passengerName: params.passengerName ?? null,
          passengerPhone: params.passengerPhone ?? null,
          pickupNote: params.pickupNote ?? null,
          reference,
        },
      });

      return { booking, departure, route };
    });
  },

  /* ── managing a booking ─────────────────────────────────────────────── */

  listBookings: async (userId: string, options: { limit?: number; upcoming?: boolean } = {}) => {
    const limit = Math.min(Math.max(options.limit ?? 20, 1), 50);
    const rows = await prisma.interstateBooking.findMany({
      where: {
        userId,
        ...(options.upcoming
          ? { status: 'CONFIRMED', departure: { departureAt: { gte: new Date() } } }
          : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: { departure: { include: { route: true, driver: { include: { user: true } } } } },
    });
    return rows.map(serializeBooking);
  },

  findBooking: async (bookingId: string, userId?: string) => {
    const booking = await prisma.interstateBooking.findUnique({
      where: { id: bookingId },
      include: { departure: { include: { route: true, driver: { include: { user: true } } } } },
    });
    if (!booking) return null;
    if (userId && booking.userId !== userId) return null;
    return serializeBooking(booking);
  },

  findBookingByReference: async (reference: string) => {
    const booking = await prisma.interstateBooking.findUnique({
      where: { reference: reference.trim().toUpperCase() },
      include: { departure: { include: { route: true, driver: { include: { user: true } } } } },
    });
    return booking ? serializeBooking(booking) : null;
  },

  /**
   * Cancel and refund per policy. Seats go back into the pool in the same
   * transaction as the refund, so a cancelled seat is never both refunded and
   * still held.
   */
  cancelBooking: async (params: {
    bookingId: string;
    userId: string;
    reason?: string;
    refundWallet: (amountNgn: number, reference: string, tx: Prisma.TransactionClient) => Promise<void>;
  }) =>
    prisma.$transaction(async (tx) => {
      const booking = await tx.interstateBooking.findUnique({
        where: { id: params.bookingId },
        include: { departure: true },
      });
      if (!booking || booking.userId !== params.userId) {
        throw new InterstateError('Booking not found.', 'BOOKING_NOT_FOUND');
      }
      if (booking.status !== 'CONFIRMED') {
        throw new InterstateError(
          `This booking is already ${booking.status.toLowerCase()}.`,
          'BOOKING_NOT_CANCELLABLE',
          { status: booking.status },
        );
      }
      if (['IN_TRANSIT', 'COMPLETED'].includes(booking.departure.status)) {
        throw new InterstateError('This trip has already departed.', 'TRIP_DEPARTED');
      }

      const fraction = refundFractionFor(booking.departure.departureAt);
      const refundNgn = Math.round(money(booking.amountNgn) * fraction * 100) / 100;

      if (refundNgn > 0) {
        await params.refundWallet(refundNgn, booking.reference, tx);
      }

      const updated = await tx.interstateBooking.update({
        where: { id: booking.id },
        data: {
          status: refundNgn > 0 ? 'REFUNDED' : 'CANCELLED',
          refundedNgn: refundNgn,
          cancelledAt: new Date(),
          cancelReason: params.reason ?? null,
        },
      });

      // A charter takes its whole departure with it; a shared seat returns to
      // the pool for someone else to buy.
      if (booking.mode === 'CHARTER') {
        await tx.interstateDeparture.update({
          where: { id: booking.departureId },
          data: { status: 'CANCELLED', cancelledAt: new Date(), cancelReason: 'Charter cancelled by rider' },
        });
      } else {
        const departure = await tx.interstateDeparture.update({
          where: { id: booking.departureId },
          data: { seatsBooked: { decrement: booking.seats } },
        });
        if (['FULL', 'FILLING'].includes(departure.status)) {
          await tx.interstateDeparture.update({
            where: { id: departure.id },
            data: { status: departure.seatsBooked > 0 ? 'FILLING' : 'SCHEDULED' },
          });
        }
      }

      return {
        booking: updated,
        refundNgn,
        refundFraction: fraction,
        forfeitedNgn: Math.round((money(booking.amountNgn) - refundNgn) * 100) / 100,
      };
    }),

  /* ── operations ─────────────────────────────────────────────────────── */

  createDeparture: (params: {
    routeId: string;
    departureAt: Date;
    vehicleType?: 'SEDAN' | 'SUV' | 'MINIBUS' | 'BUS';
    totalSeats?: number;
    minimumSeats?: number;
    seatPriceNgn?: number;
    charterPriceNgn?: number;
  }) =>
    prisma.$transaction(async (tx) => {
      const route = await tx.interstateRoute.findUniqueOrThrow({ where: { id: params.routeId } });
      const vehicleType = params.vehicleType ?? 'BUS';
      const capacity = params.totalSeats ?? { SEDAN: 4, SUV: 6, MINIBUS: 14, BUS: 30 }[vehicleType];
      return tx.interstateDeparture.create({
        data: {
          routeId: route.id,
          departureAt: params.departureAt,
          vehicleType,
          totalSeats: capacity,
          minimumSeats: params.minimumSeats ?? Math.max(1, Math.ceil(capacity * 0.4)),
          seatPriceNgn: params.seatPriceNgn ?? route.seatPriceNgn,
          charterPriceNgn: params.charterPriceNgn ?? route.charterPriceNgn,
          bookingMode: 'SHARED',
          status: 'SCHEDULED',
        },
      });
    }),

  assignDriver: (departureId: string, driverId: string, vehiclePlate?: string) =>
    prisma.interstateDeparture.update({
      where: { id: departureId },
      data: {
        driverId,
        vehiclePlate: vehiclePlate ?? null,
        status: 'DISPATCHED',
        dispatchedAt: new Date(),
      },
    }),

  setDepartureStatus: (departureId: string, status: 'IN_TRANSIT' | 'COMPLETED' | 'CANCELLED', reason?: string) =>
    prisma.$transaction(async (tx) => {
      const departure = await tx.interstateDeparture.update({
        where: { id: departureId },
        data: {
          status,
          ...(status === 'IN_TRANSIT' ? { departedAt: new Date() } : {}),
          ...(status === 'COMPLETED' ? { arrivedAt: new Date() } : {}),
          ...(status === 'CANCELLED' ? { cancelledAt: new Date(), cancelReason: reason ?? null } : {}),
        },
      });
      // Passengers follow the vehicle: a completed trip completes its bookings.
      if (status === 'COMPLETED') {
        await tx.interstateBooking.updateMany({
          where: { departureId, status: 'CONFIRMED' },
          data: { status: 'COMPLETED', completedAt: new Date() },
        });
      }
      return departure;
    }),

  /* ── driver side ──────────────────────────────────────────────────────
   *
   * An interstate driver does not get matched to a passenger; they pick up a
   * whole departure and run it. So the driver's world is three questions:
   * what can I take, what am I running, and who is on board.
   */

  /**
   * Departures nobody is driving yet, near enough in time to be worth showing.
   *
   * A trip with no passengers is not work, so empty departures are left out —
   * they are inventory, not a job.
   */
  listClaimableDepartures: (options: { withinHours?: number; limit?: number } = {}) =>
    prisma.interstateDeparture.findMany({
      where: {
        driverId: null,
        status: { in: ['SCHEDULED', 'FILLING', 'FULL'] },
        departureAt: {
          gte: new Date(),
          lte: new Date(Date.now() + (options.withinHours ?? 72) * 3_600_000),
        },
        seatsBooked: { gt: 0 },
      },
      orderBy: { departureAt: 'asc' },
      take: Math.min(Math.max(options.limit ?? 25, 1), 50),
      include: { route: true },
    }),

  /** Everything this driver is running, soonest first. */
  listDriverDepartures: (
    driverId: string,
    options: { includeFinished?: boolean; limit?: number } = {},
  ) =>
    prisma.interstateDeparture.findMany({
      where: {
        driverId,
        ...(options.includeFinished
          ? {}
          : { status: { in: ['DISPATCHED', 'IN_TRANSIT'] } }),
      },
      orderBy: { departureAt: 'asc' },
      take: Math.min(Math.max(options.limit ?? 25, 1), 50),
      include: { route: true },
    }),

  /**
   * Take a departure. Conditional on it still being unclaimed, so two drivers
   * tapping at the same moment cannot both end up believing they have the trip
   * — the second one is told, rather than silently overwriting the first.
   */
  claimDeparture: async (params: {
    departureId: string;
    driverId: string;
    vehiclePlate?: string | null;
  }) => {
    const result = await prisma.interstateDeparture.updateMany({
      where: {
        id: params.departureId,
        driverId: null,
        status: { in: ['SCHEDULED', 'FILLING', 'FULL'] },
      },
      data: {
        driverId: params.driverId,
        vehiclePlate: params.vehiclePlate ?? null,
        status: 'DISPATCHED',
        dispatchedAt: new Date(),
      },
    });

    if (result.count === 0) {
      const existing = await prisma.interstateDeparture.findUnique({
        where: { id: params.departureId },
        select: { driverId: true, status: true },
      });

      if (!existing) {
        throw new InterstateError('That trip no longer exists.', 'DEPARTURE_NOT_FOUND');
      }

      if (existing.driverId && existing.driverId !== params.driverId) {
        throw new InterstateError(
          'Another driver has already taken this trip.',
          'DEPARTURE_ALREADY_CLAIMED',
        );
      }

      if (existing.driverId === params.driverId) {
        // Already theirs — a double tap, not a conflict.
        return prisma.interstateDeparture.findUniqueOrThrow({
          where: { id: params.departureId },
          include: { route: true },
        });
      }

      throw new InterstateError(
        'This trip can no longer be taken.',
        'DEPARTURE_NOT_CLAIMABLE',
      );
    }

    return prisma.interstateDeparture.findUniqueOrThrow({
      where: { id: params.departureId },
      include: { route: true },
    });
  },

  /**
   * Move a departure the driver is actually running. Every transition is
   * checked against both the driver and the current status, so a stale screen
   * cannot complete a trip that never started.
   */
  advanceDriverDeparture: async (params: {
    departureId: string;
    driverId: string;
    to: 'IN_TRANSIT' | 'COMPLETED';
  }) => {
    const from = params.to === 'IN_TRANSIT' ? 'DISPATCHED' : 'IN_TRANSIT';

    const result = await prisma.interstateDeparture.updateMany({
      where: { id: params.departureId, driverId: params.driverId, status: from },
      data: {
        status: params.to,
        ...(params.to === 'IN_TRANSIT' ? { departedAt: new Date() } : {}),
        ...(params.to === 'COMPLETED' ? { arrivedAt: new Date() } : {}),
      },
    });

    if (result.count === 0) {
      const existing = await prisma.interstateDeparture.findUnique({
        where: { id: params.departureId },
        select: { driverId: true, status: true },
      });

      if (!existing || existing.driverId !== params.driverId) {
        throw new InterstateError('This is not one of your trips.', 'DEPARTURE_NOT_YOURS');
      }

      throw new InterstateError(
        params.to === 'IN_TRANSIT'
          ? 'This trip has already started.'
          : 'Start the trip before you finish it.',
        'DEPARTURE_WRONG_STATE',
      );
    }

    // Passengers follow the vehicle: arriving completes their bookings.
    if (params.to === 'COMPLETED') {
      await prisma.interstateBooking.updateMany({
        where: { departureId: params.departureId, status: 'CONFIRMED' },
        data: { status: 'COMPLETED', completedAt: new Date() },
      });
    }

    return prisma.interstateDeparture.findUniqueOrThrow({
      where: { id: params.departureId },
      include: { route: true },
    });
  },

  /** Who is travelling, for the driver running this departure. */
  departureManifest: async (departureId: string, driverId: string) => {
    const departure = await prisma.interstateDeparture.findUnique({
      where: { id: departureId },
      include: {
        route: true,
        bookings: {
          where: { status: { in: ['CONFIRMED', 'COMPLETED'] } },
          orderBy: { createdAt: 'asc' },
          include: { user: { select: { id: true, name: true, phone: true } } },
        },
      },
    });

    if (!departure) {
      throw new InterstateError('That trip no longer exists.', 'DEPARTURE_NOT_FOUND');
    }

    if (departure.driverId !== driverId) {
      // The manifest carries passenger phone numbers, so it is only ever shown
      // to the driver actually running the trip.
      throw new InterstateError('This is not one of your trips.', 'DEPARTURE_NOT_YOURS');
    }

    return departure;
  },

  /** Departures that never sold enough seats to be worth running. */
  findUndersoldDepartures: (withinMinutes = 120) =>
    prisma.interstateDeparture.findMany({
      where: {
        bookingMode: 'SHARED',
        status: { in: [...SELLABLE_STATUSES] },
        departureAt: { lte: new Date(Date.now() + withinMinutes * 60_000) },
      },
      include: { route: true, bookings: { where: { status: 'CONFIRMED' } } },
    }),
};

function serializeBooking(
  booking: Prisma.InterstateBookingGetPayload<{
    include: { departure: { include: { route: true; driver: { include: { user: true } } } } };
  }>,
) {
  const { departure } = booking;
  return {
    id: booking.id,
    reference: booking.reference,
    mode: booking.mode,
    seats: booking.seats,
    amountNgn: money(booking.amountNgn),
    refundedNgn: booking.refundedNgn === null ? null : money(booking.refundedNgn),
    status: booking.status,
    passengerName: booking.passengerName,
    passengerPhone: booking.passengerPhone,
    pickupNote: booking.pickupNote,
    createdAt: booking.createdAt,
    cancelledAt: booking.cancelledAt,
    cancelReason: booking.cancelReason,
    departure: {
      id: departure.id,
      departureAt: departure.departureAt,
      status: departure.status,
      vehicleType: departure.vehicleType,
      vehiclePlate: departure.vehiclePlate,
      seatsAvailable: departure.totalSeats - departure.seatsBooked,
      driver: departure.driver
        ? {
            id: departure.driver.id,
            name: departure.driver.user.name,
            phone: departure.driver.user.phone,
            rating: departure.driver.rating,
          }
        : null,
    },
    route: {
      id: departure.route.id,
      origin: {
        state: departure.route.originState,
        city: departure.route.originCity,
        terminal: departure.route.originTerminal,
      },
      destination: {
        state: departure.route.destState,
        city: departure.route.destCity,
        terminal: departure.route.destTerminal,
      },
      distanceKm: departure.route.distanceKm,
      durationMinutes: departure.route.durationMinutes,
    },
  };
}
