# Interstate, from the driver's side

A city driver is matched to one passenger at a time. An interstate driver takes
a whole **departure** — a vehicle, a time, and a list of people who have already
paid — and runs it to another state. So the driver's world is three questions,
and the endpoints answer exactly those:

| Question | Endpoint |
| --- | --- |
| What can I take? | `GET /interstate/driver/available` |
| What am I running? | `GET /interstate/driver/trips` |
| Who is on board? | `GET /interstate/driver/departures/:id/manifest` |

Plus the three state changes: `claim`, `start`, `complete`.

## Details worth knowing

**Empty departures are not offered.** `listClaimableDepartures` filters to
`seatsBooked > 0`. A trip with no passengers is inventory, not a job.

**Claiming is a race, and it is resolved.** `claimDeparture` updates
conditionally on `driverId: null`; two drivers tapping at the same moment cannot
both end up believing they have the trip. The loser is told
(`DEPARTURE_ALREADY_CLAIMED`, HTTP 409) rather than silently overwriting the
winner. A driver double-tapping their own claim gets the trip back, not an error.

**Transitions check both driver and status.** `advanceDriverDeparture` moves
`DISPATCHED → IN_TRANSIT → COMPLETED` only, so a stale screen cannot complete a
trip that never started. Arriving completes every `CONFIRMED` booking on the
departure — passengers follow the vehicle.

**The manifest is gated on being the driver.** It carries passenger phone
numbers, so `departureManifest` throws `DEPARTURE_NOT_YOURS` (HTTP 403) for
anyone else, including another Wheelers driver.

## Where it lives in the app

`app/driver/(tabs)/interstate.tsx` — its own tab, with Available / My trips, an
expandable passenger list with one-tap calling, and Start / Finish buttons that
appear only in the state where they are valid.

The rider's half is `app/rider/interstate.tsx` on the **Travel** tab: pick a
city, pick a destination, choose seats, pick a departure, pay from the wallet.
Search is two steps because the backend keys departures by route — the
destination list is what carries the `routeId`.
