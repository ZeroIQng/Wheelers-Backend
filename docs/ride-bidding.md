# Ride bidding, end to end

Wheelers is a bidding market, not a fixed-price one. The rider names a price,
nearby drivers counter with theirs, and the rider picks a driver. This document
traces that path across the three places it lives — the rider app, the API
gateway, and the ride service — because until recently the app was not part of
it at all: `app/matching.tsx` ran a 7.2-second timer, invented a driver, and
navigated on.

## The path

1. **`app/ride-selection.tsx`** — the rider sees an estimate and sets their own
   offer with +/- controls. The floor is 70% of the estimate; below that drivers
   stop looking. The chosen number travels to the next screen as `offer`.

2. **`app/matching.tsx`** — publishes the ride exactly once on mount via
   `requestRide(itinerary, { offerNgn })`, then renders the auction.

3. **`ride:request`** (gateway, `websocket/handlers/ride.handler.ts`) — plans the
   route, computes `suggestedFareNgn` / `minOfferNgn`, validates the rider's
   offer, and answers `ride:request:accepted` with `status: 'bidding'` and
   `bidsCloseAt`. That deadline is absolute so the rider's countdown survives
   leaving the screen and coming back.

4. **ride-service** broadcasts the request to candidate drivers and starts a
   `RIDE.BID_TIMEOUT_SECONDS` (180s) timer. That timer is persisted — an
   in-memory `setTimeout` used to die with the process and leave rides stuck in
   `MATCHING` forever.

5. **`ride:counter_offer`** — each driver's bid arrives and is added to
   `currentRide.offers`, deduped by driver and sorted cheapest-first.

6. The rider answers a bid three ways, all one tap apart:
   - **Accept** → `ride:accept_offer`. This books the ride; nothing before it does.
   - **Offer less** → `ride:rider_counter_offer` *with* a `driverId` — haggling
     with that one driver.
   - **Decline** → local only. The driver is not told and may bid again.

7. The rider can also move their **own** price with the +/- above the list. That
   sends `ride:rider_counter_offer` with **no** `driverId`, which ride-service
   already treats as "re-price to every candidate driver" — the same path the
   WhatsApp flow uses. The gateway used to require a `driverId` here even though
   the Kafka schema has always had it optional; it no longer does.

8. **`ride:bid_timeout`** — nobody accepted in time. The screen says so and
   offers to try again at a higher price, rather than spinning forever.

## What is deliberately not there

- **No fake driver.** `simulateMatchedRide` is gone. If the backend is not
  reachable the screen says so; it does not invent a match.
- **Declining is not broadcast.** A driver whose bid was dismissed is free to
  come back with a better price.

# Group ride face verification

Every group ride needs a verification selfie before the rider enters the
matching pool. It is checked in two places, and only one of them is a gate.

- **`POST /group-rides/face-check`** — advisory. The app calls it while the
  camera is still open, so a rider who pointed the phone at their cat hears
  about it immediately instead of three screens later. Nothing is stored.
- **`POST /group-rides/requests/:id/face-upload-complete`** — the gate. It
  downloads the object the app PUT to the presigned URL and runs the same
  `verifySelfiePhoto` check on the stored bytes. A rejected photo marks the
  verification `FAILED` and answers `422` with a retryable error; the rider is
  sent back to the camera. Passing the advisory check is not what lets someone
  through — this is.

Both use the vision prompt in `LLM/face-check.ts`, which accepts exactly one
real, live human face and rejects animals, cartoons, memes, screenshots, and
photos of a screen.

**It fails open.** If the vision service is unconfigured or down, the selfie is
accepted with a warning log. An LLM outage must not stop every group ride in
Lagos. `test/face-check.test.js` covers both directions, including the fact that
anything short of an explicit `isRealHumanFace: true` counts as a rejection.
