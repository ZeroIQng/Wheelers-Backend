#!/usr/bin/env node
/**
 * The interstate route catalogue, plus a rolling departure schedule.
 *
 * Routes are reference data, not demo data — this is safe to run against
 * production and is idempotent (upsert by origin/destination city pair).
 * Re-running it updates prices and tops the schedule back up.
 *
 *   node scripts/seed-interstate-routes.mjs                 # routes + 14 days of departures
 *   node scripts/seed-interstate-routes.mjs --days=30       # further ahead
 *   node scripts/seed-interstate-routes.mjs --routes-only   # skip the schedule
 *   node scripts/seed-interstate-routes.mjs --database-url=…
 *
 * Distances are road distances; prices are what the market charges for these
 * legs and should be reviewed before launch, not treated as gospel.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const args = Object.fromEntries(
  process.argv.slice(2).map((raw) => {
    const [key, value] = raw.replace(/^--/, '').split('=');
    return [key, value ?? true];
  }),
);

function envFile() {
  try {
    return Object.fromEntries(
      readFileSync(new URL('../.env', import.meta.url), 'utf8')
        .split(/\r?\n/)
        .filter((l) => l && !l.startsWith('#') && l.includes('='))
        .map((l) => {
          const i = l.indexOf('=');
          return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^['"]|['"]$/g, '')];
        }),
    );
  } catch {
    return {};
  }
}

const DATABASE_URL = args['database-url'] || process.env.DATABASE_URL || envFile().DATABASE_URL;
if (!DATABASE_URL) {
  console.error('No DATABASE_URL. Pass --database-url=… or set it in .env');
  process.exit(1);
}
const DAYS = Number(args.days ?? 14);
const ROUTES_ONLY = args['routes-only'] === true;

/** Terminals are real motor parks / departure points on each leg. */
const ROUTES = [
  // ── From Lagos ──
  ['Lagos', 'Lagos', 'Jibowu Terminal, Yaba', 6.5185, 3.3711, 'Oyo', 'Ibadan', 'Challenge Motor Park', 7.3600, 3.8900, 130, 150, 8000, 46000],
  ['Lagos', 'Lagos', 'Jibowu Terminal, Yaba', 6.5185, 3.3711, 'Ogun', 'Abeokuta', 'Kuto Motor Park', 7.1500, 3.3500, 100, 120, 6500, 36000],
  ['Lagos', 'Lagos', 'Jibowu Terminal, Yaba', 6.5185, 3.3711, 'Ondo', 'Akure', 'Oba Adesida Road Park', 7.2500, 5.1950, 350, 330, 19500, 105000],
  ['Lagos', 'Lagos', 'Jibowu Terminal, Yaba', 6.5185, 3.3711, 'Osun', 'Osogbo', 'Old Garage Park', 7.7700, 4.5600, 240, 260, 14000, 78000],
  ['Lagos', 'Lagos', 'Jibowu Terminal, Yaba', 6.5185, 3.3711, 'Kwara', 'Ilorin', 'Emir Road Park', 8.4900, 4.5400, 300, 300, 17000, 92000],
  ['Lagos', 'Lagos', 'Berger Terminal, Ojodu', 6.6400, 3.3600, 'Edo', 'Benin City', 'Uselu Motor Park', 6.3400, 5.6200, 320, 330, 18500, 98000],
  ['Lagos', 'Lagos', 'Berger Terminal, Ojodu', 6.6400, 3.3600, 'Delta', 'Asaba', 'Nnebisi Road Park', 6.2000, 6.7300, 390, 400, 22000, 118000],
  ['Lagos', 'Lagos', 'Berger Terminal, Ojodu', 6.6400, 3.3600, 'Delta', 'Warri', 'Effurun Roundabout Park', 5.5500, 5.7900, 340, 360, 20000, 106000],
  ['Lagos', 'Lagos', 'Berger Terminal, Ojodu', 6.6400, 3.3600, 'Anambra', 'Onitsha', 'Upper Iweka Park', 6.1400, 6.7900, 440, 450, 24000, 128000],
  ['Lagos', 'Lagos', 'Berger Terminal, Ojodu', 6.6400, 3.3600, 'Enugu', 'Enugu', 'Holy Ghost Terminal', 6.4400, 7.5000, 570, 570, 32000, 168000],
  ['Lagos', 'Lagos', 'Berger Terminal, Ojodu', 6.6400, 3.3600, 'Imo', 'Owerri', 'Douglas Road Park', 5.4800, 7.0300, 560, 570, 31000, 164000],
  ['Lagos', 'Lagos', 'Berger Terminal, Ojodu', 6.6400, 3.3600, 'Abia', 'Aba', 'Asa Road Park', 5.1100, 7.3700, 600, 620, 33000, 174000],
  ['Lagos', 'Lagos', 'Berger Terminal, Ojodu', 6.6400, 3.3600, 'Rivers', 'Port Harcourt', 'Mile 3 Motor Park', 4.8200, 7.0000, 610, 630, 36000, 188000],
  ['Lagos', 'Lagos', 'Berger Terminal, Ojodu', 6.6400, 3.3600, 'Akwa Ibom', 'Uyo', 'Itam Motor Park', 5.0400, 7.9300, 700, 720, 40000, 210000],
  ['Lagos', 'Lagos', 'Berger Terminal, Ojodu', 6.6400, 3.3600, 'Cross River', 'Calabar', 'Marian Road Park', 4.9600, 8.3200, 800, 840, 45000, 236000],
  ['Lagos', 'Lagos', 'Berger Terminal, Ojodu', 6.6400, 3.3600, 'FCT', 'Abuja', 'Utako Motor Park', 9.0700, 7.4300, 750, 720, 44000, 230000],
  ['Lagos', 'Lagos', 'Berger Terminal, Ojodu', 6.6400, 3.3600, 'Kogi', 'Lokoja', 'Ganaja Junction Park', 7.8000, 6.7400, 540, 540, 30000, 158000],

  // ── From Abuja ──
  ['FCT', 'Abuja', 'Utako Motor Park', 9.0700, 7.4300, 'Kaduna', 'Kaduna', 'Mando Motor Park', 10.5200, 7.4400, 190, 150, 12000, 68000],
  ['FCT', 'Abuja', 'Utako Motor Park', 9.0700, 7.4300, 'Plateau', 'Jos', 'Bauchi Road Park', 9.9200, 8.8900, 280, 270, 16000, 88000],
  ['FCT', 'Abuja', 'Utako Motor Park', 9.0700, 7.4300, 'Kano', 'Kano', 'Sabon Gari Park', 12.0000, 8.5200, 430, 390, 24000, 128000],
  ['FCT', 'Abuja', 'Utako Motor Park', 9.0700, 7.4300, 'Nasarawa', 'Lafia', 'Shendam Road Park', 8.4900, 8.5200, 180, 165, 11000, 62000],
  ['FCT', 'Abuja', 'Utako Motor Park', 9.0700, 7.4300, 'Benue', 'Makurdi', 'Wurukum Motor Park', 7.7300, 8.5400, 250, 240, 15000, 82000],
  ['FCT', 'Abuja', 'Utako Motor Park', 9.0700, 7.4300, 'Lagos', 'Lagos', 'Jibowu Terminal, Yaba', 6.5185, 3.3711, 750, 720, 44000, 230000],

  // ── Regional ──
  ['Oyo', 'Ibadan', 'Challenge Motor Park', 7.3600, 3.8900, 'Lagos', 'Lagos', 'Jibowu Terminal, Yaba', 6.5185, 3.3711, 130, 150, 8000, 46000],
  ['Oyo', 'Ibadan', 'Challenge Motor Park', 7.3600, 3.8900, 'FCT', 'Abuja', 'Utako Motor Park', 9.0700, 7.4300, 620, 600, 36000, 190000],
  ['Rivers', 'Port Harcourt', 'Mile 3 Motor Park', 4.8200, 7.0000, 'Lagos', 'Lagos', 'Berger Terminal, Ojodu', 6.6400, 3.3600, 610, 630, 36000, 188000],
  ['Enugu', 'Enugu', 'Holy Ghost Terminal', 6.4400, 7.5000, 'Lagos', 'Lagos', 'Berger Terminal, Ojodu', 6.6400, 3.3600, 570, 570, 32000, 168000],
  ['Edo', 'Benin City', 'Uselu Motor Park', 6.3400, 5.6200, 'Lagos', 'Lagos', 'Berger Terminal, Ojodu', 6.6400, 3.3600, 320, 330, 18500, 98000],
];

/** Long legs leave early; short hops run through the day. */
function departureHoursFor(distanceKm) {
  if (distanceKm >= 500) return [5, 6, 7, 20];       // overnight or first light
  if (distanceKm >= 250) return [6, 7, 9, 13, 16];
  return [6, 8, 10, 12, 14, 16, 18];
}

function vehicleFor(distanceKm) {
  if (distanceKm >= 500) return { type: 'BUS', seats: 30 };
  if (distanceKm >= 250) return { type: 'MINIBUS', seats: 14 };
  return { type: 'MINIBUS', seats: 14 };
}

async function main() {
  const { PrismaClient } = require('../node_modules/@prisma/client');
  const prisma = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });

  try {
    console.log(`\nSeeding interstate routes into ${DATABASE_URL.replace(/:\/\/[^@]*@/, '://***@')}`);

    const routes = [];
    for (const r of ROUTES) {
      const [
        originState, originCity, originTerminal, originLat, originLng,
        destState, destCity, destTerminal, destLat, destLng,
        distanceKm, durationMinutes, seatPriceNgn, charterPriceNgn,
      ] = r;

      const route = await prisma.interstateRoute.upsert({
        where: { originCity_destCity: { originCity, destCity } },
        create: {
          originState, originCity, originTerminal, originLat, originLng,
          destState, destCity, destTerminal, destLat, destLng,
          distanceKm, durationMinutes, seatPriceNgn, charterPriceNgn, active: true,
        },
        update: {
          originTerminal, destTerminal, distanceKm, durationMinutes,
          seatPriceNgn, charterPriceNgn, active: true,
        },
      });
      routes.push(route);
    }
    console.log(`  ${routes.length} routes upserted`);

    if (ROUTES_ONLY) {
      console.log('  --routes-only: skipping departures\n');
      return;
    }

    // Roll the schedule forward, skipping departures that already exist.
    let created = 0;
    let skipped = 0;
    const now = Date.now();

    for (const route of routes) {
      const hours = departureHoursFor(route.distanceKm);
      const vehicle = vehicleFor(route.distanceKm);

      for (let day = 0; day < DAYS; day += 1) {
        for (const hour of hours) {
          const departureAt = new Date();
          departureAt.setDate(departureAt.getDate() + day);
          departureAt.setHours(hour, 0, 0, 0);
          if (departureAt.getTime() <= now) continue;

          const existing = await prisma.interstateDeparture.findFirst({
            where: { routeId: route.id, departureAt, bookingMode: 'SHARED' },
            select: { id: true },
          });
          if (existing) {
            skipped += 1;
            continue;
          }

          await prisma.interstateDeparture.create({
            data: {
              routeId: route.id,
              departureAt,
              vehicleType: vehicle.type,
              totalSeats: vehicle.seats,
              minimumSeats: Math.max(1, Math.ceil(vehicle.seats * 0.4)),
              seatPriceNgn: route.seatPriceNgn,
              charterPriceNgn: route.charterPriceNgn,
              bookingMode: 'SHARED',
              status: 'SCHEDULED',
            },
          });
          created += 1;
        }
      }
    }

    console.log(`  ${created} departures created over the next ${DAYS} days (${skipped} already existed)`);
    console.log('\n  Done.\n');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error('\nFailed:', error);
  process.exit(1);
});
