# Emergency alerts

The button a rider or driver presses when a trip has gone wrong, and what an
operator sees when they do.

## The path

1. **`components/emergency-button.tsx`** — shared by both apps. Rider: on the
   active-trip screen, next to Share trip. Driver: floating over the map on the
   active trip, and on the Interstate tab while a long-distance trip is running,
   because a driver between states is the person furthest from help.
2. **`POST /safety/alerts`** — writes the alert and returns it.
3. **Admin nav** polls `GET /admin/alerts/count` every 20 seconds and shows a
   red badge, so an operator sitting on the Overview page finds out without
   having to think to go and look.
4. **`/admin/dashboard/alerts`** — the queue, refreshing itself every 15
   seconds. Acknowledge ("I am on this") then Resolve, which requires writing
   what happened.

## Rules that are deliberate, not incidental

**Calling 112 is always one tap, and never blocked on us.** It sits at the top
of the sheet and does not wait on any request of ours. If our servers are down,
getting someone to the police is still the useful thing this button can do.

**Raising an alert never fails on a technicality.** No ride id, no location, an
unknown counterpart — none of those stop the row being written. Location is
attached when the phone already has a fix and skipped when it does not: an alert
without coordinates still reaches a human, and one that waited for GPS may never
be sent at all.

**A second press is not a second emergency.** `findOpenForUser` returns the
existing open alert, so a frightened thumb produces one incident rather than
eight rows of the same one. The endpoint answers `200` with `alreadyOpen: true`.

**Only an operator closes one.** The app can cancel an alert it raised by
mistake (`cancelOwn`, scoped to the raiser's own id and only from a live
status). It cannot mark one resolved — resolution is an admin act, requires
written text, and records the operator's name in `handledBy`.

**Location is a snapshot, not a feed.** Where someone was when they pressed the
button is the fact that matters, not where the phone drifted to afterwards.

## Admin note

Admins live in their own table, not in `User`, so `handledBy` is a recorded name
rather than a foreign key. That is why it is a plain string.
