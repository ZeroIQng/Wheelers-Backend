#!/usr/bin/env node
/**
 * Push apps/api-gateway/src/whatsapp-flows/flow-definition.json to Meta and
 * publish it, so the screens users see match what the repo holds. The screen
 * layout LIVES ON META — deploying the server never changes it; this does.
 *
 *   node scripts/whatsapp-flow-push.mjs
 *
 * Reads META_ACCESS_TOKEN, WHATSAPP_FLOW_ID (and optionally META_WABA_ID)
 * from .env. If Meta refuses to update the current flow because it is
 * already published, the script clones it: creates a fresh flow, uploads
 * the JSON, points it at the endpoint, publishes, and rewrites
 * WHATSAPP_FLOW_ID in .env — then you MUST restart:
 *   pm2 restart ecosystem.config.cjs --update-env
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const envPath = resolve(root, '.env');
const env = Object.fromEntries(
  readFileSync(envPath, 'utf8')
    .split('\n')
    .filter((line) => line.includes('=') && !line.trim().startsWith('#'))
    .map((line) => {
      const idx = line.indexOf('=');
      return [line.slice(0, idx).trim(), line.slice(idx + 1).trim()];
    }),
);

const TOKEN = env.META_ACCESS_TOKEN;
const FLOW_ID = env.WHATSAPP_FLOW_ID;
const WABA_ID = env.META_WABA_ID || '2408321253328724';
const ENDPOINT_URI = 'https://app.wheelersng.com/webhooks/whatsapp-flow';
if (!TOKEN || !FLOW_ID) {
  console.error('META_ACCESS_TOKEN / WHATSAPP_FLOW_ID missing from .env');
  process.exit(1);
}

const BASE = 'https://graph.facebook.com/v21.0';
const jsonPath = resolve(root, 'apps/api-gateway/src/whatsapp-flows/flow-definition.json');
const flowJson = readFileSync(jsonPath, 'utf8');
JSON.parse(flowJson); // fail fast on malformed JSON

async function api(path, init = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${TOKEN}`, ...(init.headers ?? {}) },
  });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body };
}

function uploadAsset(flowId) {
  const form = new FormData();
  form.append('name', 'flow.json');
  form.append('asset_type', 'FLOW_JSON');
  form.append('file', new Blob([flowJson], { type: 'application/json' }), 'flow.json');
  return api(`/${flowId}/assets`, { method: 'POST', body: form });
}

function reportValidation(body) {
  const errors = body?.validation_errors ?? [];
  for (const e of errors) {
    console.error(`  validation ${e.error_type ?? ''}: ${e.message} (${e.pointers?.map((p) => p.path).join(', ') ?? ''})`);
  }
  return errors.length;
}

const current = await api(`/${FLOW_ID}?fields=id,name,status`);
console.log('current flow:', current.body);

// 1) Try to update the existing flow in place.
let upload = await uploadAsset(FLOW_ID);
let targetId = FLOW_ID;

if (!upload.ok) {
  console.log('in-place update refused:', upload.body?.error?.message ?? upload.body);
  console.log('cloning to a new flow…');

  const created = await api(`/${WABA_ID}/flows`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: `Wheelers Ride Book ${new Date().toISOString().slice(0, 10)}`, categories: ['OTHER'] }),
  });
  if (!created.ok) {
    console.error('flow creation failed:', JSON.stringify(created.body));
    process.exit(1);
  }
  targetId = created.body.id;
  console.log('new flow id:', targetId);

  upload = await uploadAsset(targetId);
}

if (!upload.ok) {
  console.error('asset upload failed:', JSON.stringify(upload.body));
  process.exit(1);
}
if (reportValidation(upload.body) > 0) {
  console.error('flow JSON has validation errors — fix before publishing');
  process.exit(1);
}
console.log('flow.json uploaded ✅');

// 2) Make sure the endpoint is attached (required before publish).
const meta = await api(`/${targetId}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ endpoint_uri: ENDPOINT_URI }),
});
if (!meta.ok) {
  console.log('endpoint_uri set skipped:', meta.body?.error?.message ?? meta.body);
} else {
  console.log('endpoint_uri set ✅');
}

// 3) Publish.
const published = await api(`/${targetId}/publish`, { method: 'POST' });
if (!published.ok) {
  console.error('publish failed:', JSON.stringify(published.body));
  console.error('(health check must be green — is the api-gateway up?)');
  process.exit(1);
}
console.log('published ✅');

// 4) If we cloned, rewire .env so the button opens the new flow.
if (targetId !== FLOW_ID) {
  const envRaw = readFileSync(envPath, 'utf8');
  writeFileSync(envPath, envRaw.replace(/^WHATSAPP_FLOW_ID=.*$/m, `WHATSAPP_FLOW_ID=${targetId}`));
  console.log(`\n.env updated: WHATSAPP_FLOW_ID=${targetId}`);
  console.log('NOW RUN:  pm2 restart ecosystem.config.cjs --update-env');
} else {
  console.log('\nSame flow id — no restart needed. Send "hi" and open the form.');
}
