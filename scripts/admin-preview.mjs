#!/usr/bin/env node
/**
 * Serves the admin API against a database, and nothing else.
 *
 * The real gateway needs Kafka, Redis, the outbox publisher and a WebSocket
 * server before it will boot — none of which the admin panel touches. This
 * mounts the actual admin route handlers over plain HTTP so you can drive the
 * panel against real data with just Postgres running.
 *
 *   node scripts/admin-preview.mjs
 *   node scripts/admin-preview.mjs --port=4100 --database-url=postgres://…
 *
 * Then, in Wheelers-Frontend:
 *   NEXT_PUBLIC_API_BASE_URL=http://localhost:4100 npm run dev
 *
 * Sign in with any username/password — this harness accepts anything and hands
 * back a token, because it is a local preview and never sees production.
 *
 * DEVELOPMENT ONLY. It deliberately bypasses admin authentication; never expose
 * it on a public interface.
 */
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);

const args = Object.fromEntries(
  process.argv.slice(2).map((raw) => {
    const [key, value] = raw.replace(/^--/, '').split('=');
    return [key, value ?? true];
  }),
);

function envFromFile() {
  try {
    return Object.fromEntries(
      readFileSync(new URL('../.env', import.meta.url), 'utf8')
        .split(/\r?\n/)
        .filter((line) => line && !line.startsWith('#') && line.includes('='))
        .map((line) => {
          const i = line.indexOf('=');
          return [line.slice(0, i).trim(), line.slice(i + 1).trim().replace(/^['"]|['"]$/g, '')];
        }),
    );
  } catch {
    return {};
  }
}

const PORT = Number(args.port ?? 4100);
const DATABASE_URL =
  args['database-url'] || process.env.DATABASE_URL || envFromFile().DATABASE_URL;

if (!DATABASE_URL) {
  console.error('No DATABASE_URL. Pass --database-url=… or set it in .env');
  process.exit(1);
}
process.env.DATABASE_URL = DATABASE_URL;

let routes;
let adminRoutes;
let analyticsRoutes;
try {
  routes = require('../apps/api-gateway/dist/http/admin-metrics.route.js');
  adminRoutes = require('../apps/api-gateway/dist/http/admin.route.js');
  analyticsRoutes = require('../apps/api-gateway/dist/http/admin-analytics.route.js');
} catch {
  console.error('Build the gateway first:  npm -w @wheleers/api-gateway run build');
  process.exit(1);
}

// The driver KYC screens sign document URLs through R2, which a local preview
// has no credentials for. Listing works; opening one driver's documents needs
// the real gateway.
const kycStorage = {
  getSignedUrl: async () => null,
  getSignedDownloadUrl: async () => null,
};

// The handlers run their own verifyAdminAuth; we always satisfy it locally.
const ADMIN_KEY = 'local-preview-key';
const deps = { adminApiKey: ADMIN_KEY, jwtSecret: 'local-preview-secret-not-used-for-signing' };

createServer(async (req, serverRes) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);

  serverRes.setHeader('access-control-allow-origin', '*');
  serverRes.setHeader('access-control-allow-headers', 'authorization,content-type,x-admin-key');
  serverRes.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') {
    serverRes.writeHead(204).end();
    return;
  }

  const send = (status, payload) => {
    const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
    serverRes.writeHead(status, { 'content-type': 'application/json' });
    serverRes.end(body);
    console.log(`  ${status}  ${req.method} ${url.pathname}${url.search}`);
  };

  // Shim: the handlers read the bootstrap key off the request headers.
  const shimReq = Object.assign(Object.create(Object.getPrototypeOf(req)), req, {
    headers: { ...req.headers, 'x-admin-key': ADMIN_KEY },
  });

  // Minimal ServerResponse stand-in so handlers can reply through sendJson().
  const res = {
    statusCode: 200,
    setHeader() {},
    writeHead(code) {
      this.statusCode = code;
      return this;
    },
    end(body) {
      send(this.statusCode, body ?? '');
    },
  };

  try {
    if (url.pathname === '/admin/login') {
      send(200, {
        accessToken: 'local-preview-token',
        tokenType: 'Bearer',
        admin: { id: 'local', username: 'local', name: 'Local preview' },
      });
      return;
    }

    const userMatch = url.pathname.match(/^\/admin\/users\/([^/]+)$/);
    if (userMatch) return void (await routes.handleAdminGetUserRoute(shimReq, res, deps, decodeURIComponent(userMatch[1])));
    if (url.pathname === '/admin/users') return void (await routes.handleAdminListUsersRoute(shimReq, res, deps, url));
    if (url.pathname === '/admin/rides') return void (await routes.handleAdminListRidesRoute(shimReq, res, deps, url));
    if (url.pathname === '/admin/metrics/overview') return void (await routes.handleAdminOverviewRoute(shimReq, res, deps));
    if (url.pathname === '/admin/metrics/timeseries') return void (await routes.handleAdminTimeseriesRoute(shimReq, res, deps, url));
    if (url.pathname === '/admin/metrics/cancellations') return void (await routes.handleAdminCancellationsRoute(shimReq, res, deps));
    if (url.pathname === '/admin/metrics/group-rides') return void (await routes.handleAdminGroupRideMetricsRoute(shimReq, res, deps));

    // Driver KYC queue — same handlers the gateway mounts.
    if (url.pathname === '/admin/drivers') return void (await adminRoutes.handleAdminListDriversRoute(shimReq, res, { ...deps, kycStorage }));
    const driverMatch = url.pathname.match(/^\/admin\/drivers\/([^/]+)$/);
    if (driverMatch) return void (await adminRoutes.handleAdminGetDriverRoute(shimReq, res, { ...deps, kycStorage }, decodeURIComponent(driverMatch[1])));
    if (url.pathname === '/admin/analytics/drivers') return void (await analyticsRoutes.handleAdminDriverAnalyticsRoute(shimReq, res, deps));
    if (url.pathname === '/admin/analytics/platform') return void (await analyticsRoutes.handleAdminPlatformStatsRoute(shimReq, res, deps));
    if (url.pathname === '/admin/analytics/riders') return void (await analyticsRoutes.handleAdminRiderAnalyticsRoute(shimReq, res, deps));

    send(404, { error: `Not served by the preview harness: ${url.pathname}` });
  } catch (error) {
    console.error('  handler threw:', error);
    send(500, { error: String(error?.message ?? error) });
  }
}).listen(PORT, () => {
  console.log(`\n  Admin preview API   http://localhost:${PORT}`);
  console.log(`  Database            ${DATABASE_URL.replace(/:\/\/[^@]*@/, '://***@')}`);
  console.log('\n  Now start the frontend:');
  console.log(`    cd ../Wheelers-Frontend && NEXT_PUBLIC_API_BASE_URL=http://localhost:${PORT} npm run dev`);
  console.log('\n  Then open http://localhost:3000/admin/login and sign in with anything.\n');
});
