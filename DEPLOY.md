# Deploying the server

Run these on the box, from the repo root (`~/Wheelers-Backend` or wherever you
cloned it). They are ordered so nothing serves traffic against a schema it does
not understand.

## 1. Pull

```bash
cd ~/Wheelers-Backend
git pull origin main
```

## 2. Install (only if package.json changed)

```bash
npm ci
```

Use `npm install` instead if `npm ci` complains that the lockfile is out of
sync.

## 3. Regenerate the Prisma client and build everything

```bash
npm run db:generate
npm run build
```

`npm run build` does packages first, then apps — the order matters, because the
apps import the built `@wheleers/db`.

## 4. Apply the database migrations

```bash
npm run db:migrate:deploy
```

**Three migrations are pending on this release:**

| Migration | What it does |
| --- | --- |
| `20260826180000_add_safety_alerts` | The `SafetyAlert` table behind the emergency button |
| `20260826205000_interstate_booking_status_values` | Adds `PENDING_OFFER` / `OFFER_DECLINED` booking states |
| `20260826210000_interstate_bidding` | Adds the offer columns and backfills existing bookings |

The two interstate ones are split deliberately: Postgres refuses to use a new
enum value in the same transaction that created it, and Prisma runs each
migration file in one transaction. Do not merge them back together.

Check they landed:

```bash
npx prisma migrate status --schema packages/db/prisma/schema.prisma
```

## 5. Restart

```bash
npm run pm2:restart
```

That is `pm2 restart ecosystem.config.cjs --update-env`. The `--update-env`
matters — without it pm2 keeps the environment from the last boot, so any `.env`
change you made is silently ignored.

To restart just the API:

```bash
pm2 restart api-gateway --update-env
```

## 6. Check it came up

```bash
pm2 status
pm2 logs api-gateway --lines 50 --nostream
curl -s localhost:3000/health
```

Then prove the new routes are actually mounted (401 is the right answer here —
it means the route exists and is asking for auth, rather than 404):

```bash
curl -s -o /dev/null -w '%{http_code}\n' localhost:3000/safety/alerts/active
curl -s -o /dev/null -w '%{http_code}\n' localhost:3000/interstate/driver/offers
curl -s -o /dev/null -w '%{http_code}\n' localhost:3000/admin/alerts/count
```

## If something goes wrong

```bash
pm2 logs --err --lines 100 --nostream    # what actually broke
pm2 restart all --update-env             # after fixing .env
```

A migration that fails halfway leaves the schema between versions. Do not
restart the apps until `prisma migrate status` reports everything applied.

## Reminders

- Never put a `#` comment on the same line as a value in `.env`. pm2's env
  loader does not strip them, so `MCP_PUBLIC_URL=https://... # note` becomes
  part of the URL.
- The admin panel and the mobile app are deployed separately; this file only
  covers the API and its workers.
