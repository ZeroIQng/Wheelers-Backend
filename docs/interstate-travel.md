# Interstate travel

City-to-city journeys — Lagos → Ibadan, Abuja → Kaduna, Lagos → Port Harcourt.
A rider either **buys seats on a shared vehicle** or **charters the whole
thing**. Code: `packages/db/src/clients/interstate.client.ts` (domain),
`apps/api-gateway/src/http/interstate.route.ts` (HTTP).

## Why it isn't just a long ride

A city ride is matched to a driver in the moment. An interstate journey is sold
ahead of time out of a fixed pool of seats, so the unit of inventory is a
**departure**, not a driver. Three consequences shape the whole design:

1. **Seats are the scarce thing.** Allocation runs inside a transaction with a
   conditional `updateMany` that only matches while the seats are genuinely
   free, so two riders buying the last seat cannot both win. Verified with ten
   concurrent buyers against a five-seat vehicle.
2. **Payment is part of seat allocation, not a step after it.** The HTTP layer
   passes a `chargeWallet` callback *into* the booking transaction. If the
   wallet is short the seats are never taken; if seat allocation loses a race
   the rider is never charged. There is no window where one happened without
   the other.
3. **Prices are snapshotted onto the departure.** Re-pricing a route later never
   rewrites what an existing passenger agreed to pay.

## Endpoints

All require a rider bearer token.

| Endpoint | Purpose |
|---|---|
| `GET /interstate/cities` | Cities you can depart from. `?from=Lagos` returns destinations with prices. |
| `GET /interstate/routes?origin=&destination=&state=` | The route catalogue. |
| `POST /interstate/quote` `{routeId, mode?, seats?}` | Price a journey. Returns the alternative mode's price too, so a group can see whether chartering beats buying seats. |
| `GET /interstate/departures?routeId=&date=&seats=` | Shared departures with room. `date` is `YYYY-MM-DD` and means the whole day. |
| `POST /interstate/bookings` `{departureId, seats, passengerName?, passengerPhone?, pickupNote?}` | Buy seats. Max 10 — beyond that, charter. |
| `POST /interstate/charters` `{routeId, departureAt, vehicleType?}` | Charter a whole vehicle. Creates a departure reserved to that booking. |
| `GET /interstate/bookings?upcoming=true` | The rider's bookings. |
| `GET /interstate/bookings/:id` | One booking, with driver and vehicle once dispatched. |
| `POST /interstate/bookings/:id/cancel` `{reason?}` | Cancel and refund per policy. |

Bookings close **30 minutes** before departure. Riders book for other people
routinely, so `passengerName`/`passengerPhone` are separate from the account.

Each booking carries a short reference (`WHL-8F3K2Q`) that reads out loud at a
terminal desk.

## Refund policy

| Cancelled | Refund |
|---|---|
| 24h or more before departure | 100% |
| 6–24h before | 75% |
| 2–6h before | 50% |
| under 2h | nothing |

Cancelling a shared seat puts it straight back on sale; cancelling a charter
cancels its departure. Both happen in the same transaction as the refund, so a
seat is never both refunded and still held.

## Vehicles

`SEDAN` 4 · `SUV` 6 · `MINIBUS` 14 · `BUS` 30. Long legs (500km+) run buses on
early-morning and overnight slots; shorter hops run minibuses through the day.

## Operations

`interstateClient` also exposes `createDeparture`, `assignDriver`,
`setDepartureStatus` (completing a trip completes its passengers), and
`findUndersoldDepartures` — departures that never reached `minimumSeats` and are
not economic to run. Wiring that last one to an automatic cancel-and-refund
sweep is the obvious next step; right now it only reports.

## Seeding the catalogue

Routes are reference data, not demo data — the script is idempotent and safe in
production.

```sh
node scripts/seed-interstate-routes.mjs              # 28 routes + 14 days of departures
node scripts/seed-interstate-routes.mjs --days=30
node scripts/seed-interstate-routes.mjs --routes-only
```

28 routes across Lagos, Abuja, Ibadan, Port Harcourt, Enugu and Benin, with real
terminals (Jibowu, Utako, Upper Iweka, Mile 3) and road distances. **Prices are
market estimates and should be reviewed before launch**, not treated as final.

## Tests

```sh
npm run test:interstate
```

Covers pricing (charter must not scale with seats), the wallet coupling in both
directions, overselling under concurrency, the booking cutoff, every band of the
refund policy, double-cancel, cancelling someone else's booking, and charter
exclusivity.

## Not built yet

- No Kafka events, so no push/WhatsApp confirmation on booking. The rest of the
  platform is event-driven; this should emit `INTERSTATE_BOOKED` and friends.
- No driver-facing side: `assignDriver` exists but nothing dispatches, and
  drivers cannot see or accept an interstate job from the app.
- No admin screens — departures and bookings are API-only so far.
- Undersold departures are detected but not auto-cancelled.
