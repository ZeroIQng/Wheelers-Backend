// End-to-end test for apps/mcp-server against a fake api-gateway.
//
// Covers the real wiring: OAuth discovery, dynamic client registration, the
// PKCE authorize → login page → code → token exchange, bearer-protected MCP
// initialize/tools, the WebSocket ride session (request → driver bid →
// accept), and refresh-token rotation. Needs only Redis on REDIS_URL
// (default redis://localhost:6379); the gateway is stubbed in-process.
//
// Run: npm run build && node --test test/mcp-server.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createHash, randomBytes } = require('node:crypto');
const wsLib = require('ws');
const WebSocketServer = wsLib.WebSocketServer ?? wsLib.Server;

const ROOT = path.resolve(__dirname, '..');
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';
const USER_ID = 'user-mcp-test-1';
const DRIVER_ID = 'driver-1';
const DRIVER_USER_ID = 'user-driver-1';

function b64url(buffer) {
  return Buffer.from(buffer).toString('base64url');
}

function fakeJwt(sub, ttlSeconds) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({ sub, typ: 'wheelers.local.auth', iat: now, exp: now + ttlSeconds }));
  return `${header}.${payload}.${b64url(randomBytes(32))}`;
}

const GATEWAY_TOKEN = fakeJwt(USER_ID, 60 * 60 * 24 * 30);

function freePort() {
  return new Promise((resolve) => {
    const probe = http.createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

/** Minimal stand-in for api-gateway: the routes and WS events the MCP server uses. */
async function startFakeGateway() {
  const calls = [];
  const wsEvents = [];
  const otpSends = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const auth = req.headers.authorization;
    const send = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    calls.push(`${req.method} ${url.pathname}`);

    if (req.method === 'POST' && url.pathname === '/auth/signin') {
      const body = await readJson(req);
      if (body.identifier === 'timi' && body.password === 'correct-horse') {
        return send(200, { accessToken: GATEWAY_TOKEN, tokenType: 'Bearer', user: { id: USER_ID, email: 'timi@example.com', role: 'RIDER', name: 'Timi', phone: null } });
      }
      return send(401, { error: 'Invalid email or password.' });
    }

    if (req.method === 'POST' && url.pathname === '/auth/phone/login/send-otp') {
      const body = await readJson(req);
      if (body.phone === '+2348099999999') return send(409, { error: 'WhatsApp only lets us message you after you message Wheelers first.', code: 'OTP_WINDOW_CLOSED', whatsappNumber: '+2348141979106' });
      if (body.phone !== '+2348012345678') return send(400, { error: 'phone must be a valid E.164 number, for example +2348012345678' });
      otpSends.push(body.phone);
      return send(200, { sent: true, channel: 'whatsapp', phone: body.phone, expiresInSeconds: 300 });
    }
    if (req.method === 'POST' && url.pathname === '/auth/phone/login/verify-otp') {
      const body = await readJson(req);
      if (body.phone !== '+2348012345678' || body.code !== '123456') return send(400, { error: 'Invalid sign-in code', code: 'OTP_INVALID', attemptsRemaining: 4 });
      return send(200, { accessToken: GATEWAY_TOKEN, tokenType: 'Bearer', isNewUser: false, user: { id: USER_ID, privyDid: 'whatsapp:+2348012345678', email: null, role: 'RIDER', name: 'Timi', phone: '+2348012345678' } });
    }

    if (auth !== `Bearer ${GATEWAY_TOKEN}`) return send(401, { error: 'Authorization bearer token is required' });

    if (url.pathname === '/auth/me') return send(200, { user: { id: USER_ID, email: 'timi@example.com', role: 'RIDER', name: 'Timi', phone: null, username: 'timi' } });
    if (url.pathname === '/wallet/overview') return send(200, { walletId: 'w1', balanceNgn: 12500, lockedNgn: 0, updatedAt: new Date().toISOString() });
    if (url.pathname === '/rides/active') return send(200, { ride: null });
    if (url.pathname.startsWith('/rides/')) {
      return send(200, { ride: { id: url.pathname.slice(7), status: 'MATCHING', riderId: USER_ID, driver: null } });
    }
    return send(404, { error: 'Not found' });
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== '/ws' || url.searchParams.get('accessToken') !== GATEWAY_TOKEN) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const reply = (type, payload) => ws.send(JSON.stringify({ type, payload, timestamp: new Date().toISOString() }));
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        wsEvents.push(msg.type);
        if (msg.type === 'ride:request') {
          reply('ride:request:accepted', { rideId: msg.payload.rideId, status: 'bidding', riderOfferNgn: msg.payload.offerNgn ?? 3000, suggestedFareNgn: 3000, minOfferNgn: 3000, route: { coordinates: [] } });
          setTimeout(() => reply('ride:counter_offer', { rideId: msg.payload.rideId, driverId: DRIVER_ID, driverUserId: DRIVER_USER_ID, counterOfferNgn: 3500, driverName: 'Ade', driverRating: 4.8, vehiclePlate: 'LND-123', vehicleModel: 'Corolla', etaSeconds: 240, distanceKm: 1.2 }), 50);
        } else if (msg.type === 'ride:accept_offer') {
          assert.equal(msg.payload.driverUserId, DRIVER_USER_ID);
          assert.equal(msg.payload.agreedFareNgn, 3500);
          reply('ride:accept_offer:accepted', { rideId: msg.payload.rideId, driverId: msg.payload.driverId, agreedFareNgn: msg.payload.agreedFareNgn });
          setTimeout(() => reply('ride:matched', { rideId: msg.payload.rideId, driverId: DRIVER_ID, driverName: 'Ade', vehiclePlate: 'LND-123', etaSeconds: 200, agreedFareNgn: 3500 }), 30);
        } else if (msg.type === 'ride:cancel') {
          reply('ride:cancel:accepted', { rideId: msg.payload.rideId });
          reply('ride:cancelled', { rideId: msg.payload.rideId, reason: msg.payload.reason, cancelledBy: 'rider' });
        } else {
          reply('error', { message: `Unknown event type: ${msg.type}` });
        }
      });
    });
  });

  const port = await listen(server);
  return {
    port, calls, wsEvents, otpSends,
    close: () => new Promise((resolve) => {
      for (const client of wss.clients) client.terminate();
      wss.close();
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}

async function startMcpServer(gatewayPort) {
  const port = await freePort();
  const publicUrl = `http://127.0.0.1:${port}`;
  const env = { ...process.env };
  delete env.GOOGLE_MAPS_API_KEY; // tools receive lat/lng in this test; no geocoding
  const child = spawn(process.execPath, [path.join(ROOT, 'apps/mcp-server/dist/index.js')], {
    cwd: ROOT,
    env: {
      ...env,
      NODE_ENV: 'test',
      MCP_PORT: String(port),
      MCP_PUBLIC_URL: publicUrl,
      MCP_GATEWAY_BASE_URL: `http://127.0.0.1:${gatewayPort}`,
      REDIS_URL,
      MCP_ACCESS_TOKEN_TTL_S: '3600',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (d) => { output += d.toString(); });
  child.stderr.on('data', (d) => { output += d.toString(); });

  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`mcp-server exited early:\n${output}`);
    try {
      const res = await fetch(`${publicUrl}/health`);
      if (res.ok) return { publicUrl, child, output: () => output };
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  child.kill('SIGKILL');
  throw new Error(`mcp-server did not start:\n${output}`);
}

async function mcpCall(publicUrl, token, method, params, id = 1) {
  const res = await fetch(`${publicUrl}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2025-06-18',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  const text = await res.text();
  assert.equal(res.status, 200, `${method} → HTTP ${res.status}: ${text}`);
  const body = JSON.parse(text);
  assert.ok(!body.error, `${method} → ${JSON.stringify(body.error)}`);
  return body.result;
}

async function expectJson(res, status) {
  const text = await res.text();
  assert.equal(res.status, status, `HTTP ${res.status}: ${text}`);
  return JSON.parse(text);
}

function toolJson(result) {
  assert.ok(Array.isArray(result.content) && result.content[0]?.type === 'text', JSON.stringify(result));
  return { data: JSON.parse(result.content[0].text), isError: result.isError === true };
}

test('mcp-server: OAuth 2.1 + MCP + ride session end to end', async (t) => {
  // Redis must be reachable, otherwise skip rather than fail CI without infra.
  try {
    const IORedis = require('ioredis');
    const probe = new IORedis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 });
    await probe.connect();
    await probe.del(`mcp:user:${USER_ID}:active-ride`);
    await probe.quit();
  } catch (error) {
    t.skip(`Redis not reachable at ${REDIS_URL}: ${error.message}`);
    return;
  }

  const gateway = await startFakeGateway();
  const mcp = await startMcpServer(gateway.port);
  t.after(async () => {
    mcp.child.kill('SIGKILL');
    await gateway.close();
  });
  const { publicUrl } = mcp;

  // ── Discovery ──────────────────────────────────────────────────────────
  const asMeta = await (await fetch(`${publicUrl}/.well-known/oauth-authorization-server`)).json();
  assert.equal(asMeta.issuer, `${publicUrl}/`);
  assert.ok(asMeta.code_challenge_methods_supported.includes('S256'));
  assert.ok(asMeta.registration_endpoint, 'dynamic client registration advertised');

  const prm = await (await fetch(`${publicUrl}/.well-known/oauth-protected-resource/mcp`)).json();
  assert.equal(prm.resource, `${publicUrl}/mcp`);
  const prmRoot = await (await fetch(`${publicUrl}/.well-known/oauth-protected-resource`)).json();
  assert.equal(prmRoot.resource, `${publicUrl}/mcp`);

  // ── Unauthenticated /mcp → 401 pointing at resource metadata ───────────
  const unauth = await fetch(`${publicUrl}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(unauth.status, 401);
  assert.match(unauth.headers.get('www-authenticate') ?? '', /resource_metadata=/);

  // ── Dynamic client registration (what Claude does) ─────────────────────
  const redirectUri = 'http://127.0.0.1:9999/callback';
  const reg = await fetch(asMeta.registration_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'Claude (test)', redirect_uris: [redirectUri], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }),
  });
  const client = await expectJson(reg, 201);
  assert.ok(client.client_id);

  // ── Authorize with PKCE → login page ───────────────────────────────────
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  const authorizeUrl = new URL(asMeta.authorization_endpoint);
  authorizeUrl.search = new URLSearchParams({
    response_type: 'code', client_id: client.client_id, redirect_uri: redirectUri,
    code_challenge: challenge, code_challenge_method: 'S256', state: 'xyz-123', scope: 'wheelers:user',
  }).toString();
  const authorize = await fetch(authorizeUrl, { redirect: 'manual' });
  assert.equal(authorize.status, 302);
  const loginLocation = authorize.headers.get('location');
  assert.match(loginLocation, /^\/oauth\/login\?sid=/);

  const loginPage = await fetch(`${publicUrl}${loginLocation}`);
  assert.equal(loginPage.status, 200);
  const loginHtml = await loginPage.text();
  assert.match(loginHtml, /Claude \(test\)/, 'login page names the client');
  assert.match(loginHtml, /name="phone"/, 'phone (WhatsApp) sign-in is the default');
  assert.doesNotMatch(loginHtml, /name="password"/);
  const sid = new URL(loginLocation, publicUrl).searchParams.get('sid');

  // ── Phone sign-in: local number format → E.164 → code on WhatsApp ─────
  const form = (path, params) => fetch(`${publicUrl}${path}`, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  // Rider outside Meta's 24h window: page offers the "say hi on WhatsApp" step with a wa.me link.
  const closed = await form('/oauth/login/phone', { sid, phone: '0809 999 9999' });
  assert.equal(closed.status, 200);
  const closedHtml = await closed.text();
  assert.match(closedHtml, /https:\/\/wa\.me\/2348141979106\?text=/);
  assert.match(closedHtml, /Send me a code/);

  const sent = await form('/oauth/login/phone', { sid, phone: '0801 234 5678' });
  assert.equal(sent.status, 200);
  const codePage = await sent.text();
  assert.match(codePage, /name="code"/);
  assert.match(codePage, /value="\+2348012345678"/, 'number normalised to E.164 for the gateway');
  assert.deepEqual(gateway.otpSends, ['+2348012345678']);

  const wrongCode = await form('/oauth/login/phone/verify', { sid, phone: '+2348012345678', code: '000000' });
  assert.equal(wrongCode.status, 400);
  assert.match(await wrongCode.text(), /Invalid sign-in code/);

  const phoneLogin = await form('/oauth/login/phone/verify', { sid, phone: '+2348012345678', code: '123456' });
  assert.equal(phoneLogin.status, 302);
  const phoneCallback = new URL(phoneLogin.headers.get('location'));
  assert.equal(phoneCallback.searchParams.get('state'), 'xyz-123');
  const phoneCode = phoneCallback.searchParams.get('code');
  assert.ok(phoneCode);
  const phoneTokens = await expectJson(await fetch(asMeta.token_endpoint, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code: phoneCode, code_verifier: verifier, client_id: client.client_id, redirect_uri: redirectUri }),
  }), 200);
  const phoneMe = toolJson(await mcpCall(publicUrl, phoneTokens.access_token, 'tools/call', { name: 'get_my_profile', arguments: {} }, 100));
  assert.equal(phoneMe.data.user.id, USER_ID, 'phone sign-in lands on the WhatsApp account');

  // ── Password sign-in on a fresh authorize (login session was consumed) ─
  const authorize2 = await fetch(authorizeUrl, { redirect: 'manual' });
  const loginLocation2 = authorize2.headers.get('location');
  const sid2 = new URL(loginLocation2, publicUrl).searchParams.get('sid');
  const pwPage = await (await fetch(`${publicUrl}/oauth/login?sid=${sid2}&mode=signin`)).text();
  assert.match(pwPage, /name="identifier"/);

  // Wrong password: gateway error surfaced verbatim, no redirect.
  const badLogin = await fetch(`${publicUrl}/oauth/login`, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ sid: sid2, mode: 'signin', identifier: 'timi', password: 'nope' }),
  });
  assert.equal(badLogin.status, 400);
  assert.match(await badLogin.text(), /Invalid email or password\./);

  const login = await fetch(`${publicUrl}/oauth/login`, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ sid: sid2, mode: 'signin', identifier: 'timi', password: 'correct-horse' }),
  });
  assert.equal(login.status, 302);
  const callback = new URL(login.headers.get('location'));
  assert.equal(`${callback.origin}${callback.pathname}`, redirectUri);
  assert.equal(callback.searchParams.get('state'), 'xyz-123');
  const code = callback.searchParams.get('code');
  assert.ok(code);

  // ── Token exchange (PKCE verified by the SDK) ──────────────────────────
  const badVerifier = await fetch(asMeta.token_endpoint, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: 'wrong', client_id: client.client_id, redirect_uri: redirectUri }),
  });
  assert.equal(badVerifier.status, 400, 'wrong PKCE verifier is rejected');

  const tokenRes = await fetch(asMeta.token_endpoint, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: client.client_id, redirect_uri: redirectUri }),
  });
  const tokens = await expectJson(tokenRes, 200);
  assert.equal(tokens.token_type, 'Bearer');
  assert.ok(tokens.access_token && tokens.refresh_token);
  assert.ok(tokens.expires_in <= 3600 && tokens.expires_in > 0);

  // Code is single-use.
  const replay = await fetch(asMeta.token_endpoint, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: client.client_id, redirect_uri: redirectUri }),
  });
  assert.equal(replay.status, 400);

  // ── MCP session ────────────────────────────────────────────────────────
  const init = await mcpCall(publicUrl, tokens.access_token, 'initialize', {
    protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' },
  });
  assert.equal(init.serverInfo.name, 'wheelers');
  assert.match(init.instructions ?? '', /Booking a ride/);

  const tools = await mcpCall(publicUrl, tokens.access_token, 'tools/list', {}, 2);
  const names = tools.tools.map((tool) => tool.name);
  for (const expected of ['get_my_profile', 'estimate_ride', 'request_ride', 'list_ride_offers', 'accept_ride_offer', 'cancel_ride', 'get_wallet_overview', 'request_withdrawal', 'schedule_ride', 'get_driver_stats']) {
    assert.ok(names.includes(expected), `tool ${expected} registered`);
  }
  const withdrawal = tools.tools.find((tool) => tool.name === 'request_withdrawal');
  assert.equal(withdrawal.annotations.destructiveHint, true);

  const profile = toolJson(await mcpCall(publicUrl, tokens.access_token, 'tools/call', { name: 'get_my_profile', arguments: {} }, 3));
  assert.equal(profile.isError, false);
  assert.equal(profile.data.user.id, USER_ID);

  const wallet = toolJson(await mcpCall(publicUrl, tokens.access_token, 'tools/call', { name: 'get_wallet_overview', arguments: {} }, 4));
  assert.equal(wallet.data.balanceNgn, 12500);

  // Gateway errors come back as tool errors with the real message.
  const notFound = toolJson(await mcpCall(publicUrl, tokens.access_token, 'tools/call', { name: 'get_referral_summary', arguments: {} }, 5));
  assert.equal(notFound.isError, true);
  assert.equal(notFound.data.httpStatus, 404);

  // ── Ride booking over the WebSocket session ────────────────────────────
  const requested = toolJson(await mcpCall(publicUrl, tokens.access_token, 'tools/call', {
    name: 'request_ride',
    arguments: { pickup: { lat: 6.43, lng: 3.42, address: 'Lekki Phase 1' }, destination: { lat: 6.45, lng: 3.40, address: 'Victoria Island' }, offerNgn: 3000 },
  }, 6));
  assert.equal(requested.isError, false, JSON.stringify(requested.data));
  assert.equal(requested.data.status, 'bidding');
  const rideId = requested.data.rideId;
  assert.ok(rideId);
  assert.ok(gateway.wsEvents.includes('ride:request'));

  // A second request while one is live is refused.
  const dup = toolJson(await mcpCall(publicUrl, tokens.access_token, 'tools/call', {
    name: 'request_ride',
    arguments: { pickup: { lat: 6.43, lng: 3.42 }, destination: { lat: 6.45, lng: 3.40 } },
  }, 7));
  assert.equal(dup.isError, true);
  assert.equal(dup.data.rideId, rideId);

  await new Promise((r) => setTimeout(r, 300));
  const offers = toolJson(await mcpCall(publicUrl, tokens.access_token, 'tools/call', { name: 'list_ride_offers', arguments: {} }, 8));
  assert.equal(offers.data.rideId, rideId);
  assert.equal(offers.data.bids.length, 1);
  assert.equal(offers.data.bids[0].driverId, DRIVER_ID);
  assert.equal(offers.data.bids[0].counterOfferNgn, 3500);

  const accepted = toolJson(await mcpCall(publicUrl, tokens.access_token, 'tools/call', { name: 'accept_ride_offer', arguments: { driverId: DRIVER_ID } }, 9));
  assert.equal(accepted.isError, false, JSON.stringify(accepted.data));
  assert.equal(accepted.data.agreedFareNgn, 3500);

  await new Promise((r) => setTimeout(r, 200));
  const status = toolJson(await mcpCall(publicUrl, tokens.access_token, 'tools/call', { name: 'get_ride_status', arguments: {} }, 10));
  assert.equal(status.data.live.phase, 'matched');
  assert.equal(status.data.live.matched.driverName, 'Ade');
  assert.equal(status.data.ride.id, rideId);

  const cancelled = toolJson(await mcpCall(publicUrl, tokens.access_token, 'tools/call', { name: 'cancel_ride', arguments: { reason: 'test' } }, 11));
  assert.equal(cancelled.data.cancelled, true);

  // ── Refresh token rotation ─────────────────────────────────────────────
  const refreshRes = await fetch(asMeta.token_endpoint, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: client.client_id }),
  });
  const refreshed = await expectJson(refreshRes, 200);
  assert.ok(refreshed.access_token && refreshed.access_token !== tokens.access_token);

  const reuse = await fetch(asMeta.token_endpoint, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: client.client_id }),
  });
  assert.equal(reuse.status, 400, 'old refresh token is dead after rotation');

  const me2 = toolJson(await mcpCall(publicUrl, refreshed.access_token, 'tools/call', { name: 'get_my_profile', arguments: {} }, 12));
  assert.equal(me2.data.user.id, USER_ID);

  // Raw gateway JWT works as a bearer too (Claude Code --header path).
  const raw = toolJson(await mcpCall(publicUrl, GATEWAY_TOKEN, 'tools/call', { name: 'get_my_profile', arguments: {} }, 13));
  assert.equal(raw.data.user.id, USER_ID);
  assert.ok(gateway.calls.includes('GET /auth/me'));
});
