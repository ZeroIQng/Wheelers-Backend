import express, { type Request, type Response, type Router } from 'express';
import { GatewayClient, GatewayError, type AuthResponse } from '../gateway/client';
import { OAuthStore, readJwtExpiry, type LoginSession } from './store';

export interface LoginRouterDeps {
  store: OAuthStore;
  gateway: GatewayClient;
}

type Mode = 'phone' | 'code' | 'signin' | 'signup';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function field(req: Request, key: string): string {
  const body = req.body as Record<string, unknown> | undefined;
  const value = body?.[key];
  return typeof value === 'string' ? value.trim() : '';
}

/** Riders type numbers every which way; the gateway wants strict E.164. */
function normalizePhoneInput(raw: string, defaultCountryCode = '234'): string {
  let digits = raw.replace(/[^\d+]/g, '');
  if (digits.startsWith('+')) return digits;
  if (digits.startsWith('00')) return `+${digits.slice(2)}`;
  if (digits.startsWith('0')) digits = defaultCountryCode + digits.slice(1);
  else if (!digits.startsWith(defaultCountryCode)) digits = defaultCountryCode + digits;
  return `+${digits}`;
}

function maskPhone(phone: string): string {
  return phone.length > 6 ? `${phone.slice(0, 4)}•••${phone.slice(-3)}` : phone;
}

function renderPage(input: {
  sid: string;
  clientName: string | null;
  mode: Mode;
  error?: string;
  notice?: string;
  values?: Record<string, string>;
}): string {
  const client = escapeHtml(input.clientName ?? 'An AI assistant');
  const v = (key: string) => escapeHtml(input.values?.[key] ?? '');
  const error = input.error ? `<div class="error" role="alert">${escapeHtml(input.error)}</div>` : '';
  const notice = input.notice ? `<div class="notice">${escapeHtml(input.notice)}</div>` : '';
  const sid = escapeHtml(input.sid);

  const phone = `
    <form method="post" action="/oauth/login/phone">
      <input type="hidden" name="sid" value="${sid}">
      <label>WhatsApp phone number<input name="phone" type="tel" inputmode="tel" value="${v('phone')}" placeholder="+234 801 234 5678" autocomplete="tel" required autofocus></label>
      <button type="submit">Send me a code on WhatsApp</button>
    </form>
    <p class="switch">Same number you use with the Wheelers WhatsApp bot or app — it's one account everywhere.</p>
    <p class="switch"><a href="/oauth/login?sid=${sid}&mode=signin">Use email &amp; password instead</a></p>`;

  const code = `
    <form method="post" action="/oauth/login/phone/verify">
      <input type="hidden" name="sid" value="${sid}">
      <input type="hidden" name="phone" value="${v('phone')}">
      <p class="sub">We sent a 6-digit code to <strong>${escapeHtml(maskPhone(input.values?.['phone'] ?? ''))}</strong> on WhatsApp.</p>
      <label>Sign-in code<input name="code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code" required autofocus></label>
      <button type="submit">Verify &amp; connect</button>
    </form>
    <form method="post" action="/oauth/login/phone" class="inline">
      <input type="hidden" name="sid" value="${sid}">
      <input type="hidden" name="phone" value="${v('phone')}">
      <p class="switch">Didn't get it? <button type="submit" class="link">Resend code</button> · <a href="/oauth/login?sid=${sid}">Change number</a></p>
    </form>`;

  const signin = `
    <form method="post" action="/oauth/login">
      <input type="hidden" name="sid" value="${sid}">
      <input type="hidden" name="mode" value="signin">
      <label>Email or username<input name="identifier" value="${v('identifier')}" autocomplete="username" required autofocus></label>
      <label>Password<input name="password" type="password" autocomplete="current-password" required></label>
      <button type="submit">Sign in &amp; connect</button>
    </form>
    <p class="switch"><a href="/oauth/login?sid=${sid}">Sign in with WhatsApp code instead</a> · <a href="/oauth/login?sid=${sid}&mode=signup">Create an account</a></p>`;

  const signup = `
    <form method="post" action="/oauth/login">
      <input type="hidden" name="sid" value="${sid}">
      <input type="hidden" name="mode" value="signup">
      <label>Full name<input name="fullName" value="${v('fullName')}" autocomplete="name" required autofocus></label>
      <label>Email<input name="email" type="email" value="${v('email')}" autocomplete="email" required></label>
      <label>Phone (WhatsApp, e.g. +2348012345678)<input name="phone" value="${v('phone')}" autocomplete="tel"></label>
      <label>Password (8+ characters)<input name="password" type="password" autocomplete="new-password" minlength="8" required></label>
      <button type="submit">Create account &amp; connect</button>
    </form>
    <p class="switch">Already have an account? <a href="/oauth/login?sid=${sid}">Sign in with WhatsApp code</a></p>`;

  const body = { phone, code, signin, signup }[input.mode];

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connect ${client} to Wheelers</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0f1115; color: #f2f3f5; display: flex; min-height: 100vh; align-items: center; justify-content: center; }
  main { width: min(420px, 92vw); background: #181b22; border: 1px solid #262a33; border-radius: 16px; padding: 28px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  p.sub { margin: 0 0 20px; color: #9aa3b2; font-size: 14px; }
  label { display: block; font-size: 13px; color: #c3c9d4; margin-bottom: 12px; }
  input { display: block; width: 100%; box-sizing: border-box; margin-top: 6px; padding: 10px 12px; border-radius: 8px; border: 1px solid #333846; background: #0f1115; color: #f2f3f5; font-size: 15px; }
  input:focus { outline: 2px solid #f5b400; border-color: transparent; }
  button { width: 100%; padding: 12px; border: 0; border-radius: 8px; background: #f5b400; color: #111; font-weight: 600; font-size: 15px; cursor: pointer; margin-top: 4px; }
  button.link { width: auto; padding: 0; margin: 0; background: none; color: #f5b400; font-weight: 400; font-size: inherit; text-decoration: underline; }
  form.inline { margin-top: 0; }
  .error { background: #3a1d1d; border: 1px solid #7a2e2e; color: #ffb4b4; padding: 10px 12px; border-radius: 8px; font-size: 14px; margin-bottom: 14px; }
  .notice { background: #1d2f22; border: 1px solid #2e6a3e; color: #b8f0c4; padding: 10px 12px; border-radius: 8px; font-size: 14px; margin-bottom: 14px; }
  .switch { font-size: 13px; color: #9aa3b2; text-align: center; margin: 16px 0 0; }
  a { color: #f5b400; }
  .scope { font-size: 12px; color: #7f8797; margin-top: 18px; line-height: 1.5; }
</style>
</head>
<body>
<main>
  <h1>Connect to Wheelers</h1>
  <p class="sub"><strong>${client}</strong> wants to book rides, check your wallet and manage your Wheelers account on your behalf.</p>
  ${error}
  ${notice}
  ${body}
  <p class="scope">You can disconnect at any time from the assistant's settings. The assistant only receives a revocable access token — never your code or password.</p>
</main>
</body>
</html>`;
}

function renderExpired(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Link expired</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#0f1115;color:#f2f3f5;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}main{max-width:420px;padding:28px;text-align:center}</style></head>
<body><main><h1>This sign-in link has expired</h1><p>Go back to your assistant and start the connection again.</p></main></body></html>`;
}

function describeGatewayError(error: unknown, fallback: string): { message: string; status: number } {
  if (error instanceof GatewayError) {
    if (error.status === 0) return { message: 'Wheelers is temporarily unreachable. Please try again in a moment.', status: 502 };
    return { message: error.message, status: error.status >= 500 ? 502 : error.status === 429 ? 429 : 400 };
  }
  return { message: error instanceof Error ? error.message : fallback, status: 400 };
}

export function createLoginRouter(deps: LoginRouterDeps): Router {
  const router = express.Router();
  router.use(express.urlencoded({ extended: false }));

  async function loadSession(req: Request, res: Response, sid: string): Promise<LoginSession | null> {
    const session = sid ? await deps.store.getLoginSession(sid) : null;
    if (!session) res.status(400).type('html').send(renderExpired());
    return session;
  }

  router.get('/oauth/login', async (req: Request, res: Response) => {
    const sid = typeof req.query['sid'] === 'string' ? req.query['sid'] : '';
    const session = await loadSession(req, res, sid);
    if (!session) return;
    const requested = req.query['mode'];
    const mode: Mode = requested === 'signup' ? 'signup' : requested === 'signin' ? 'signin' : 'phone';
    res.type('html').send(renderPage({ sid, clientName: session.clientName, mode }));
  });

  // Step 1 of phone sign-in: send the code.
  router.post('/oauth/login/phone', async (req: Request, res: Response) => {
    const sid = field(req, 'sid');
    const session = await loadSession(req, res, sid);
    if (!session) return;

    const rawPhone = field(req, 'phone');
    if (!rawPhone) {
      res.status(400).type('html').send(renderPage({ sid, clientName: session.clientName, mode: 'phone', error: 'Enter your WhatsApp phone number.' }));
      return;
    }
    const phone = normalizePhoneInput(rawPhone);

    try {
      const sent = await deps.gateway.phoneLoginSendOtp(phone);
      res.type('html').send(
        renderPage({
          sid,
          clientName: session.clientName,
          mode: 'code',
          values: { phone: sent.phone },
          notice: sent.channel === 'whatsapp' ? 'Code sent on WhatsApp.' : 'Code sent by SMS.',
        }),
      );
    } catch (error) {
      const described = describeGatewayError(error, 'Could not send the code.');
      res.status(described.status).type('html').send(
        renderPage({ sid, clientName: session.clientName, mode: 'phone', error: described.message, values: { phone: rawPhone } }),
      );
    }
  });

  // Step 2: verify the code → same account the WhatsApp bot uses.
  router.post('/oauth/login/phone/verify', async (req: Request, res: Response) => {
    const sid = field(req, 'sid');
    const session = await loadSession(req, res, sid);
    if (!session) return;

    const phone = field(req, 'phone');
    const code = field(req, 'code').replace(/\s+/g, '');
    if (!phone || !/^\d{6}$/.test(code)) {
      res.status(400).type('html').send(
        renderPage({ sid, clientName: session.clientName, mode: 'code', values: { phone }, error: 'Enter the 6-digit code from WhatsApp.' }),
      );
      return;
    }

    let auth: AuthResponse;
    try {
      auth = await deps.gateway.phoneLoginVerify(phone, code);
    } catch (error) {
      const described = describeGatewayError(error, 'Could not verify the code.');
      const locked = error instanceof GatewayError && (error.code === 'OTP_LOCKED' || error.code === 'OTP_NOT_FOUND');
      res.status(described.status).type('html').send(
        renderPage({ sid, clientName: session.clientName, mode: locked ? 'phone' : 'code', values: { phone }, error: described.message }),
      );
      return;
    }

    await finishAuthorization(deps, res, sid, session, auth);
  });

  // Email/username + password (and sign-up) for accounts created in the app.
  router.post('/oauth/login', async (req: Request, res: Response) => {
    const sid = field(req, 'sid');
    const session = await loadSession(req, res, sid);
    if (!session) return;

    const mode: 'signin' | 'signup' = field(req, 'mode') === 'signup' ? 'signup' : 'signin';
    const values: Record<string, string> = {
      identifier: field(req, 'identifier'),
      fullName: field(req, 'fullName'),
      email: field(req, 'email'),
      phone: field(req, 'phone'),
    };

    let auth: AuthResponse;
    try {
      if (mode === 'signup') {
        auth = await deps.gateway.signup({
          fullName: values.fullName || undefined,
          email: values.email || undefined,
          phone: values.phone ? normalizePhoneInput(values.phone) : undefined,
          password: field(req, 'password'),
          role: 'RIDER',
        });
      } else {
        if (!values.identifier || !field(req, 'password')) {
          throw new GatewayError('Email/username and password are required.', 400, undefined, null);
        }
        auth = await deps.gateway.signin(values.identifier, field(req, 'password'));
      }
    } catch (error) {
      const described = describeGatewayError(error, 'Sign-in failed.');
      res.status(described.status).type('html').send(
        renderPage({ sid, clientName: session.clientName, mode, error: described.message, values }),
      );
      return;
    }

    await finishAuthorization(deps, res, sid, session, auth);
  });

  return router;
}

async function finishAuthorization(
  deps: LoginRouterDeps,
  res: Response,
  sid: string,
  session: LoginSession,
  auth: AuthResponse,
): Promise<void> {
  const gatewayTokenExp = readJwtExpiry(auth.accessToken) ?? Math.floor(Date.now() / 1000) + 60 * 60 * 24;

  const code = await deps.store.createAuthorizationCode({
    clientId: session.clientId,
    redirectUri: session.redirectUri,
    codeChallenge: session.codeChallenge,
    scopes: session.scopes,
    resource: session.resource,
    userId: auth.user.id,
    gatewayToken: auth.accessToken,
    gatewayTokenExp,
  });
  await deps.store.deleteLoginSession(sid);

  const redirect = new URL(session.redirectUri);
  redirect.searchParams.set('code', code);
  if (session.state) redirect.searchParams.set('state', session.state);
  res.redirect(redirect.toString());
}
