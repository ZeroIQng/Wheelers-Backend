// Interstate travel: pricing, seat inventory under concurrency, wallet
// coupling, and the refund policy.
//
// Needs Postgres with migrations applied and the route catalogue seeded:
//   node scripts/seed-interstate-routes.mjs
//   DATABASE_URL=… node --test test/interstate.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const { PrismaClient } = require('@prisma/client');
const { interstateClient, InterstateError, refundFractionFor } = require('../packages/db/dist');

const prisma = new PrismaClient();

const HOUR = 3_600_000;
let scratchUserIds = [];

async function makeRider(balanceNgn) {
  const user = await prisma.user.create({
    data: {
      privyDid: `test:interstate:${Math.random().toString(36).slice(2)}`,
      role: 'RIDER',
      name: 'Interstate Test Rider',
    },
  });
  await prisma.wallet.create({ data: { userId: user.id, balanceNgn } });
  scratchUserIds.push(user.id);
  return user;
}

/** Charges exactly like the HTTP layer does, inside the booking transaction. */
function charge(userId) {
  return async (amountNgn, reference, tx) => {
    const wallet = await tx.wallet.findUnique({ where: { userId } });
    if (!wallet) throw new InterstateError('No wallet', 'NO_WALLET');
    if (Number(wallet.balanceNgn) < amountNgn) {
      throw new InterstateError('Insufficient balance.', 'INSUFFICIENT_BALANCE');
    }
    const updated = await tx.wallet.update({
      where: { id: wallet.id },
      data: { balanceNgn: { decrement: amountNgn } },
    });
    await tx.transaction.create({
      data: {
        walletId: wallet.id,
        type: 'RIDE_PAYMENT',
        direction: 'DEBIT',
        amountNgn,
        balanceAfterNgn: updated.balanceNgn,
        referenceId: reference,
      },
    });
  };
}

function refund(userId) {
  return async (amountNgn, reference, tx) => {
    const wallet = await tx.wallet.findUnique({ where: { userId } });
    if (!wallet) return;
    const updated = await tx.wallet.update({
      where: { id: wallet.id },
      data: { balanceNgn: { increment: amountNgn } },
    });
    await tx.transaction.create({
      data: {
        walletId: wallet.id,
        type: 'REFUND',
        direction: 'CREDIT',
        amountNgn,
        balanceAfterNgn: updated.balanceNgn,
        referenceId: `refund-${reference}`,
      },
    });
  };
}

async function makeDeparture(seats, hoursFromNow = 48) {
  const route = await prisma.interstateRoute.findFirstOrThrow({ where: { active: true } });
  const departure = await prisma.interstateDeparture.create({
    data: {
      routeId: route.id,
      departureAt: new Date(Date.now() + hoursFromNow * HOUR),
      vehicleType: 'MINIBUS',
      totalSeats: seats,
      seatPriceNgn: 10000,
      charterPriceNgn: 90000,
      bookingMode: 'SHARED',
      status: 'SCHEDULED',
      minimumSeats: 1,
    },
  });
  return { departure, route };
}

const balanceOf = async (userId) =>
  Number((await prisma.wallet.findUniqueOrThrow({ where: { userId } })).balanceNgn);

test.after(async () => {
  // Remove only what these tests created.
  const bookings = await prisma.interstateBooking.findMany({
    where: { userId: { in: scratchUserIds } },
    select: { departureId: true },
  });
  await prisma.interstateBooking.deleteMany({ where: { userId: { in: scratchUserIds } } });
  await prisma.interstateDeparture.deleteMany({
    where: { id: { in: bookings.map((b) => b.departureId) }, bookingMode: 'CHARTER' },
  });
  const walletIds = (
    await prisma.wallet.findMany({ where: { userId: { in: scratchUserIds } }, select: { id: true } })
  ).map((w) => w.id);
  await prisma.transaction.deleteMany({ where: { walletId: { in: walletIds } } });
  await prisma.wallet.deleteMany({ where: { userId: { in: scratchUserIds } } });
  await prisma.user.deleteMany({ where: { id: { in: scratchUserIds } } });
  await prisma.$disconnect();
});

test('quote prices shared per seat and charter as a flat vehicle rate', async () => {
  const route = await prisma.interstateRoute.findFirstOrThrow({ where: { active: true } });

  const shared = await interstateClient.quote({ routeId: route.id, mode: 'SHARED', seats: 3 });
  assert.equal(shared.totalNgn, Number(route.seatPriceNgn) * 3);
  assert.equal(shared.pricePerSeatNgn, Number(route.seatPriceNgn));

  const charter = await interstateClient.quote({ routeId: route.id, mode: 'CHARTER', seats: 3 });
  assert.equal(charter.totalNgn, Number(route.charterPriceNgn));
  // Charter must not scale with seats — it is the whole vehicle.
  const charter7 = await interstateClient.quote({ routeId: route.id, mode: 'CHARTER', seats: 7 });
  assert.equal(charter7.totalNgn, charter.totalNgn);

  assert.equal(shared.alternative.mode, 'CHARTER');
  assert.equal(charter.alternative.mode, 'SHARED');
});

test('booking seats debits the wallet for exactly the fare', async () => {
  const rider = await makeRider(100000);
  const { departure } = await makeDeparture(6);

  const { booking, seatsRemaining } = await interstateClient.bookSeats({
    departureId: departure.id,
    userId: rider.id,
    seats: 2,
    chargeWallet: charge(rider.id),
  });

  assert.equal(booking.status, 'CONFIRMED');
  assert.equal(booking.seats, 2);
  assert.equal(Number(booking.amountNgn), 20000);
  assert.match(booking.reference, /^WHL-[A-Z0-9]{6}$/);
  assert.equal(seatsRemaining, 4);
  assert.equal(await balanceOf(rider.id), 80000);

  const after = await prisma.interstateDeparture.findUniqueOrThrow({ where: { id: departure.id } });
  assert.equal(after.seatsBooked, 2);
  assert.equal(after.status, 'FILLING');
});

test('an unaffordable trip takes no seat and no money', async () => {
  const rider = await makeRider(5000); // fare is 10,000
  const { departure } = await makeDeparture(4);

  await assert.rejects(
    () =>
      interstateClient.bookSeats({
        departureId: departure.id,
        userId: rider.id,
        seats: 1,
        chargeWallet: charge(rider.id),
      }),
    /Insufficient balance/,
  );

  // The seat claim must have rolled back with the failed payment.
  const after = await prisma.interstateDeparture.findUniqueOrThrow({ where: { id: departure.id } });
  assert.equal(after.seatsBooked, 0, 'seats were held despite payment failing');
  assert.equal(await balanceOf(rider.id), 5000);
  const bookings = await prisma.interstateBooking.count({ where: { userId: rider.id } });
  assert.equal(bookings, 0);
});

test('concurrent buyers cannot oversell the last seats', async () => {
  const SEATS = 5;
  const { departure } = await makeDeparture(SEATS);

  // Ten riders all try for two seats at once on a five-seat vehicle.
  const riders = await Promise.all(Array.from({ length: 10 }, () => makeRider(100000)));
  const results = await Promise.allSettled(
    riders.map((rider) =>
      interstateClient.bookSeats({
        departureId: departure.id,
        userId: rider.id,
        seats: 2,
        chargeWallet: charge(rider.id),
      }),
    ),
  );

  const won = results.filter((r) => r.status === 'fulfilled');
  const lost = results.filter((r) => r.status === 'rejected');

  const after = await prisma.interstateDeparture.findUniqueOrThrow({ where: { id: departure.id } });
  assert.ok(after.seatsBooked <= SEATS, `oversold: ${after.seatsBooked} of ${SEATS}`);
  assert.equal(after.seatsBooked, won.length * 2);
  assert.equal(won.length, 2, 'exactly two riders should fit two seats each into five');
  assert.equal(lost.length, 8);

  // Everyone who lost keeps their money.
  for (const [i, result] of results.entries()) {
    const expected = result.status === 'fulfilled' ? 80000 : 100000;
    assert.equal(await balanceOf(riders[i].id), expected);
  }

  const confirmed = await prisma.interstateBooking.count({
    where: { departureId: departure.id, status: 'CONFIRMED' },
  });
  assert.equal(confirmed, won.length, 'a booking exists for every successful claim and no others');
});

test('bookings close shortly before departure', async () => {
  const rider = await makeRider(100000);
  const { departure } = await makeDeparture(6, 0.2); // ~12 minutes away

  await assert.rejects(
    () =>
      interstateClient.bookSeats({
        departureId: departure.id,
        userId: rider.id,
        seats: 1,
        chargeWallet: charge(rider.id),
      }),
    /Bookings close/,
  );
});

test('refund policy scales with how late the cancellation is', () => {
  const at = (hours) => new Date(Date.now() + hours * HOUR);
  assert.equal(refundFractionFor(at(48)), 1);
  assert.equal(refundFractionFor(at(24)), 1);
  assert.equal(refundFractionFor(at(12)), 0.75);
  assert.equal(refundFractionFor(at(3)), 0.5);
  assert.equal(refundFractionFor(at(0.5)), 0);
});

test('cancelling returns the seat to the pool and refunds per policy', async () => {
  const rider = await makeRider(100000);
  const { departure } = await makeDeparture(6, 48); // full refund window

  const { booking } = await interstateClient.bookSeats({
    departureId: departure.id,
    userId: rider.id,
    seats: 2,
    chargeWallet: charge(rider.id),
  });
  assert.equal(await balanceOf(rider.id), 80000);

  const result = await interstateClient.cancelBooking({
    bookingId: booking.id,
    userId: rider.id,
    reason: 'Plans changed',
    refundWallet: refund(rider.id),
  });

  assert.equal(result.refundNgn, 20000);
  assert.equal(result.forfeitedNgn, 0);
  assert.equal(result.booking.status, 'REFUNDED');
  assert.equal(await balanceOf(rider.id), 100000);

  const after = await prisma.interstateDeparture.findUniqueOrThrow({ where: { id: departure.id } });
  assert.equal(after.seatsBooked, 0, 'the seat must go back on sale');
});

test('a late cancellation forfeits part of the fare', async () => {
  const rider = await makeRider(100000);
  const { departure } = await makeDeparture(6, 3); // inside the 50% band

  const { booking } = await interstateClient.bookSeats({
    departureId: departure.id,
    userId: rider.id,
    seats: 1,
    chargeWallet: charge(rider.id),
  });

  const result = await interstateClient.cancelBooking({
    bookingId: booking.id,
    userId: rider.id,
    refundWallet: refund(rider.id),
  });

  assert.equal(result.refundNgn, 5000);
  assert.equal(result.forfeitedNgn, 5000);
  assert.equal(await balanceOf(rider.id), 95000);
});

test('a booking cannot be cancelled twice', async () => {
  const rider = await makeRider(100000);
  const { departure } = await makeDeparture(4, 48);
  const { booking } = await interstateClient.bookSeats({
    departureId: departure.id,
    userId: rider.id,
    seats: 1,
    chargeWallet: charge(rider.id),
  });

  await interstateClient.cancelBooking({ bookingId: booking.id, userId: rider.id, refundWallet: refund(rider.id) });
  await assert.rejects(
    () => interstateClient.cancelBooking({ bookingId: booking.id, userId: rider.id, refundWallet: refund(rider.id) }),
    /already refunded/i,
  );
  assert.equal(await balanceOf(rider.id), 100000, 'a double cancel must not pay out twice');
});

test('one rider cannot cancel another rider\'s booking', async () => {
  const owner = await makeRider(100000);
  const stranger = await makeRider(100000);
  const { departure } = await makeDeparture(4, 48);
  const { booking } = await interstateClient.bookSeats({
    departureId: departure.id,
    userId: owner.id,
    seats: 1,
    chargeWallet: charge(owner.id),
  });

  await assert.rejects(
    () =>
      interstateClient.cancelBooking({
        bookingId: booking.id,
        userId: stranger.id,
        refundWallet: refund(stranger.id),
      }),
    /Booking not found/,
  );
  assert.equal(await balanceOf(stranger.id), 100000);
});

test('a charter takes the whole vehicle and never appears in shared search', async () => {
  const rider = await makeRider(200000);
  const route = await prisma.interstateRoute.findFirstOrThrow({ where: { active: true } });
  const departureAt = new Date(Date.now() + 72 * HOUR);

  const { booking, departure } = await interstateClient.charter({
    routeId: route.id,
    userId: rider.id,
    departureAt,
    vehicleType: 'SUV',
    chargeWallet: charge(rider.id),
  });

  assert.equal(booking.mode, 'CHARTER');
  assert.equal(Number(booking.amountNgn), Number(route.charterPriceNgn));
  assert.equal(departure.bookingMode, 'CHARTER');
  assert.equal(departure.seatsBooked, departure.totalSeats, 'a charter holds every seat');
  assert.equal(departure.status, 'FULL');

  const shared = await interstateClient.searchDepartures({
    routeId: route.id,
    from: new Date(departureAt.getTime() - HOUR),
    to: new Date(departureAt.getTime() + HOUR),
  });
  assert.ok(
    !shared.some((d) => d.id === departure.id),
    'a private charter must not be sold to strangers',
  );

  // Seats on a charter departure cannot be bought individually either.
  const other = await makeRider(100000);
  await assert.rejects(
    () =>
      interstateClient.bookSeats({
        departureId: departure.id,
        userId: other.id,
        seats: 1,
        chargeWallet: charge(other.id),
      }),
    /private charter/,
  );
});

test('completing a trip completes its passengers', async () => {
  const rider = await makeRider(100000);
  const { departure } = await makeDeparture(6, 48);
  const { booking } = await interstateClient.bookSeats({
    departureId: departure.id,
    userId: rider.id,
    seats: 1,
    chargeWallet: charge(rider.id),
  });

  await interstateClient.setDepartureStatus(departure.id, 'COMPLETED');

  const after = await prisma.interstateBooking.findUniqueOrThrow({ where: { id: booking.id } });
  assert.equal(after.status, 'COMPLETED');
  assert.ok(after.completedAt);
});
