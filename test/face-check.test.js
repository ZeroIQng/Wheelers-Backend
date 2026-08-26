// The group-ride selfie gate: what the vision model is actually asked, which
// verdicts let a rider through, and what happens when it is down.
//
// This is the check that turns away a cat, a meme, or a photo of a screen. It
// runs on the app's upload as well as the WhatsApp one, so a rider cannot get
// past it by switching clients.
//
// Every HTTP call is stubbed — no image ever leaves this process.
//
//   node --test test/face-check.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const { verifySelfiePhoto } = require('../apps/api-gateway/dist/LLM/face-check.js');
const { GroqClient } = require('../apps/api-gateway/dist/LLM/groq.client.js');

const CONFIGURED = { apiKey: 'gsk-test', model: 'test-model', timeoutMs: 5000 };
const IMAGE = Buffer.from('not-really-a-jpeg-but-the-model-is-stubbed');

/** Replaces global fetch with one that answers as the Groq vision endpoint. */
function stubVision(handler) {
  const calls = [];
  const original = global.fetch;
  global.fetch = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(String(init.body)) });
    const { status = 200, payload } = handler(calls.length) ?? {};
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => payload,
      text: async () => JSON.stringify(payload),
    };
  };
  return { calls, restore: () => { global.fetch = original; } };
}

const verdict = (value) => () => ({
  status: 200,
  payload: { choices: [{ message: { content: JSON.stringify(value) } }] },
});

test('a real human face is accepted', async () => {
  const stub = stubVision(verdict({ isRealHumanFace: true, reason: 'clear front-facing face' }));
  try {
    const result = await verifySelfiePhoto(new GroqClient(CONFIGURED), IMAGE, 'image/jpeg');
    assert.equal(result.accepted, true);
    assert.equal(result.reason, 'clear front-facing face');
  } finally {
    stub.restore();
  }
});

test('a cat is not a face', async () => {
  const stub = stubVision(verdict({ isRealHumanFace: false, reason: 'this is a cat' }));
  try {
    const result = await verifySelfiePhoto(new GroqClient(CONFIGURED), IMAGE, 'image/jpeg');
    assert.equal(result.accepted, false, 'a cat must not clear the selfie gate');
    assert.equal(result.reason, 'this is a cat');
  } finally {
    stub.restore();
  }
});

test('anything short of an explicit yes is a no', async () => {
  // The model returning "maybe", a string, or nothing at all must not read as
  // acceptance — only `isRealHumanFace === true` does.
  for (const value of [
    { isRealHumanFace: 'true', reason: 'stringly typed' },
    { isRealHumanFace: null, reason: 'unsure' },
    { reason: 'field missing entirely' },
  ]) {
    const stub = stubVision(verdict(value));
    try {
      const result = await verifySelfiePhoto(new GroqClient(CONFIGURED), IMAGE, 'image/jpeg');
      assert.equal(result.accepted, false, `${JSON.stringify(value)} must not be accepted`);
    } finally {
      stub.restore();
    }
  }
});

test('the image really is sent to the model, inline and typed', async () => {
  const stub = stubVision(verdict({ isRealHumanFace: true, reason: 'ok' }));
  try {
    await verifySelfiePhoto(new GroqClient(CONFIGURED), IMAGE, 'image/png');

    assert.equal(stub.calls.length, 1);
    const content = stub.calls[0].body.messages[0].content;
    const imagePart = content.find((part) => part.type === 'image_url');
    assert.ok(imagePart, 'the request must carry the image, not just the prompt');
    assert.equal(
      imagePart.image_url.url,
      `data:image/png;base64,${IMAGE.toString('base64')}`,
      'the mime type must survive — a mislabelled data URL is rejected by the model',
    );

    const textPart = content.find((part) => part.type === 'text');
    assert.match(textPart.text, /ONE real, live human face/);
    assert.match(textPart.text, /not an animal/);
  } finally {
    stub.restore();
  }
});

test('an unconfigured vision service fails open, so an outage cannot strand every rider', async () => {
  const result = await verifySelfiePhoto(
    new GroqClient({ model: 'test-model', timeoutMs: 5000 }),
    IMAGE,
    'image/jpeg',
  );
  assert.equal(result.accepted, true);
  assert.match(result.reason, /unavailable/);
});

test('a failing vision call fails open too', async () => {
  const stub = stubVision(() => ({ status: 500, payload: { error: { message: 'upstream on fire' } } }));
  try {
    const result = await verifySelfiePhoto(new GroqClient(CONFIGURED), IMAGE, 'image/jpeg');
    assert.equal(result.accepted, true, 'a 500 from the model must not block a real rider');
    assert.match(result.reason, /unavailable/);
  } finally {
    stub.restore();
  }
});

test('an unparseable verdict fails open rather than guessing', async () => {
  const stub = stubVision(() => ({
    status: 200,
    payload: { choices: [{ message: { content: 'I think that is a person?' } }] },
  }));
  try {
    const result = await verifySelfiePhoto(new GroqClient(CONFIGURED), IMAGE, 'image/jpeg');
    assert.equal(result.accepted, true);
    assert.match(result.reason, /unavailable/);
  } finally {
    stub.restore();
  }
});
