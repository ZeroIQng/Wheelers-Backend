// The OTP delivery chain: which provider gets used, what happens when the
// cheap one refuses, and that Twilio Verify round-trips.
//
// Every HTTP call is stubbed — this test never sends a real message.
//
//   node --test test/otp-channels.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  availableChannels,
  isOtpConfigured,
  deliverOtp,
  checkTwilioVerify,
  OtpDeliveryFailed,
} = require('../apps/api-gateway/dist/otp/channels.js');

const META = { metaAccessToken: 'meta-token', metaPhoneNumberId: '1234567890' };
const TWILIO = { twilioAccountSid: 'ACtest', twilioAuthToken: 'secret' };
const SMS = { ...TWILIO, twilioFromNumber: '+14155550100' };
const WA = { ...TWILIO, twilioWhatsappNumber: '+14155238886' };
const VERIFY = { ...TWILIO, twilioVerifyServiceSid: 'VAtest' };

const PHONE = '+2348012345678';

/**
 * Replaces global fetch for one test. `routes` maps a substring of the URL to
 * a handler returning { status, body }.
 */
function stubFetch(routes) {
  const calls = [];
  const original = global.fetch;
  global.fetch = async (url, init) => {
    const href = String(url);
    calls.push({ url: href, body: init?.body ? String(init.body) : null });
    for (const [needle, handler] of Object.entries(routes)) {
      if (href.includes(needle)) {
        const { status = 200, body = '{}' } = handler({ url: href, init }) ?? {};
        return {
          ok: status >= 200 && status < 300,
          status,
          text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
          json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
        };
      }
    }
    throw new Error(`unstubbed request: ${href}`);
  };
  return { calls, restore: () => { global.fetch = original; } };
}

const ok = () => ({ status: 200, body: { messages: [{ id: 'wamid.test' }] } });
const metaWindowClosed = () => ({
  status: 400,
  body: { error: { code: 131047, message: 'Re-engagement message', error_data: { details: 'outside window' } } },
});

test('channel detection reflects what is actually configured', () => {
  assert.deepEqual(availableChannels({}), []);
  assert.equal(isOtpConfigured({}), false);

  assert.deepEqual(availableChannels(META), ['meta_whatsapp']);
  assert.deepEqual(availableChannels(SMS), ['twilio_sms']);
  assert.deepEqual(availableChannels({ ...META, ...WA, ...SMS }), [
    'meta_whatsapp',
    'twilio_whatsapp',
    'twilio_sms',
  ]);

  // Twilio Verify supersedes the raw Twilio channels — same job, no templates.
  assert.deepEqual(availableChannels({ ...META, ...VERIFY }), ['meta_whatsapp', 'twilio_verify']);

  // A half-configured Twilio account offers nothing.
  assert.deepEqual(availableChannels({ twilioAccountSid: 'ACtest' }), []);
});

test('an explicit channel order is honoured, unconfigured entries skipped', () => {
  const config = { ...META, ...SMS, channelOrder: 'twilio_sms,meta_whatsapp,twilio_whatsapp' };
  assert.deepEqual(availableChannels(config), ['twilio_sms', 'meta_whatsapp']);
});

test('Meta is used first when it is available', async () => {
  const stub = stubFetch({ 'graph.facebook.com': ok });
  try {
    const result = await deliverOtp({ ...META, ...SMS }, { phone: PHONE, code: '123456', body: 'code 123456' });
    assert.equal(result.channel, 'meta_whatsapp');
    assert.equal(result.medium, 'whatsapp');
    assert.equal(result.providerManaged, false);
    assert.equal(stub.calls.length, 1, 'no fallback should be attempted after success');
  } finally {
    stub.restore();
  }
});

test('a closed 24h window falls through Meta to Twilio SMS', async () => {
  const stub = stubFetch({
    'graph.facebook.com': metaWindowClosed,
    'api.twilio.com': ok,
  });
  try {
    const result = await deliverOtp({ ...META, ...SMS }, { phone: PHONE, code: '123456', body: 'code 123456' });
    assert.equal(result.channel, 'twilio_sms', 'SMS is the channel with no window to close');
    assert.equal(result.medium, 'sms');
    assert.equal(stub.calls.length, 2);

    const sms = stub.calls[1];
    const params = new URLSearchParams(sms.body);
    assert.equal(params.get('To'), PHONE);
    assert.equal(params.get('From'), '+14155550100');
    assert.match(params.get('Body'), /123456/);
  } finally {
    stub.restore();
  }
});

test('Twilio WhatsApp is tried before SMS and addresses are prefixed', async () => {
  const stub = stubFetch({
    'graph.facebook.com': metaWindowClosed,
    'api.twilio.com': ok,
  });
  try {
    const result = await deliverOtp(
      { ...META, ...WA, ...SMS },
      { phone: PHONE, code: '999111', body: 'code 999111' },
    );
    assert.equal(result.channel, 'twilio_whatsapp');
    const params = new URLSearchParams(stub.calls[1].body);
    assert.equal(params.get('To'), `whatsapp:${PHONE}`);
    assert.equal(params.get('From'), 'whatsapp:+14155238886');
  } finally {
    stub.restore();
  }
});

test('Twilio WhatsApp session errors also fall through to SMS', async () => {
  let twilioCall = 0;
  const stub = stubFetch({
    'api.twilio.com': () => {
      twilioCall += 1;
      // 63016 is Twilio's own "outside the 24h session" for WhatsApp.
      return twilioCall === 1
        ? { status: 400, body: { code: 63016, message: 'Failed to send freeform message' } }
        : ok();
    },
  });
  try {
    const result = await deliverOtp({ ...WA, ...SMS }, { phone: PHONE, code: '123456', body: 'code' });
    assert.equal(result.channel, 'twilio_sms');
    assert.equal(twilioCall, 2);
  } finally {
    stub.restore();
  }
});

test('Twilio Verify issues the code itself and reports as provider-managed', async () => {
  const stub = stubFetch({
    'verify.twilio.com': () => ({ status: 201, body: { sid: 'VEtest', status: 'pending' } }),
  });
  try {
    const result = await deliverOtp(VERIFY, { phone: PHONE, code: 'unused', body: 'unused' });
    assert.equal(result.channel, 'twilio_verify');
    assert.equal(result.providerManaged, true, 'we must not check this code ourselves');
    assert.equal(result.medium, 'whatsapp');

    const params = new URLSearchParams(stub.calls[0].body);
    assert.equal(params.get('To'), PHONE);
    assert.equal(params.get('Channel'), 'whatsapp');
  } finally {
    stub.restore();
  }
});

test('Twilio Verify check approves a good code and rejects a bad one', async () => {
  let stub = stubFetch({
    'VerificationCheck': () => ({ status: 200, body: { status: 'approved', valid: true } }),
  });
  try {
    assert.equal(await checkTwilioVerify(VERIFY, PHONE, '123456'), true);
  } finally {
    stub.restore();
  }

  stub = stubFetch({
    'VerificationCheck': () => ({ status: 200, body: { status: 'pending', valid: false } }),
  });
  try {
    assert.equal(await checkTwilioVerify(VERIFY, PHONE, '000000'), false);
  } finally {
    stub.restore();
  }

  // An expired verification 404s — a failed check, not an outage.
  stub = stubFetch({ 'VerificationCheck': () => ({ status: 404, body: { code: 20404 } }) });
  try {
    assert.equal(await checkTwilioVerify(VERIFY, PHONE, '000000'), false);
  } finally {
    stub.restore();
  }
});

test('when every channel fails the error names each attempt', async () => {
  const stub = stubFetch({
    'graph.facebook.com': metaWindowClosed,
    'api.twilio.com': () => ({ status: 401, body: { code: 20003, message: 'Authenticate' } }),
  });
  try {
    await assert.rejects(
      () => deliverOtp({ ...META, ...SMS }, { phone: PHONE, code: '1', body: 'x' }),
      (error) => {
        assert.ok(error instanceof OtpDeliveryFailed);
        assert.equal(error.attempts.length, 2);
        assert.deepEqual(error.attempts.map((a) => a.channel), ['meta_whatsapp', 'twilio_sms']);
        assert.match(error.message, /meta_whatsapp/);
        assert.match(error.message, /twilio_sms/);
        assert.equal(error.allWindowClosed, false, 'a Twilio auth failure is not a window problem');
        return true;
      },
    );
  } finally {
    stub.restore();
  }
});

test('a pure window failure is reported as such, so the UI can offer the fix', async () => {
  const stub = stubFetch({ 'graph.facebook.com': metaWindowClosed });
  try {
    await assert.rejects(
      () => deliverOtp(META, { phone: PHONE, code: '1', body: 'x' }),
      (error) => {
        assert.equal(error.allWindowClosed, true);
        return true;
      },
    );
  } finally {
    stub.restore();
  }
});

test('with nothing configured the failure says so instead of pretending', async () => {
  await assert.rejects(
    () => deliverOtp({}, { phone: PHONE, code: '1', body: 'x' }),
    /No verification channel is configured/,
  );
});
