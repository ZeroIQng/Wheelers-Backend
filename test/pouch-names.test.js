// Pouch only accepts letters in customer names; WhatsApp profile names carry
// emoji and decorative fonts. The display name is never touched — only what we
// send to Pouch is cleaned.
//
//   npm -w @wheleers/pouch-client run build && node --test test/pouch-names.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { pouchNameParts, sanitizePouchName } = require('../packages/pouch-client/dist/index.js');

test('plain names split into first/last unchanged', () => {
  assert.deepEqual(pouchNameParts('Timilehin Olowu'), { firstName: 'Timilehin', lastName: 'Olowu' });
  assert.deepEqual(pouchNameParts('Ada Obi Nwosu'), { firstName: 'Ada', lastName: 'Obi Nwosu' });
});

test('emoji are stripped, the letters survive', () => {
  assert.deepEqual(pouchNameParts('Timi 🔥'), { firstName: 'Timi', lastName: 'User' });
  assert.deepEqual(pouchNameParts('✨Blessing✨ Okafor💃🏾'), { firstName: 'Blessing', lastName: 'Okafor' });
  assert.deepEqual(pouchNameParts('Timi🔥Olowu'), { firstName: 'Timi', lastName: 'Olowu' });
});

test('decorative unicode fonts and accents fold to ASCII', () => {
  assert.equal(sanitizePouchName('𝓣𝓲𝓶𝓲 𝓞𝓵𝓸𝔀𝓾'), 'Timi Olowu');
  assert.equal(sanitizePouchName('Adéọlá Ọ̀ṣun'), 'Adeola Osun');
  assert.equal(sanitizePouchName('Ｔｉｍｉ'), 'Timi');
});

test('nothing usable falls back to the default', () => {
  assert.deepEqual(pouchNameParts('🔥🔥🔥'), { firstName: 'Wheelers', lastName: 'User' });
  assert.deepEqual(pouchNameParts(''), { firstName: 'Wheelers', lastName: 'User' });
  assert.deepEqual(pouchNameParts(null), { firstName: 'Wheelers', lastName: 'User' });
  assert.deepEqual(pouchNameParts(undefined, { firstName: 'Wheelers', lastName: 'Driver' }), {
    firstName: 'Wheelers',
    lastName: 'Driver',
  });
  assert.deepEqual(pouchNameParts('123 456'), { firstName: 'Wheelers', lastName: 'User' });
});

test('apostrophes and hyphens inside a name stay, stray punctuation goes', () => {
  assert.deepEqual(pouchNameParts("O'Neil Smith-Jones"), { firstName: "O'Neil", lastName: 'Smith-Jones' });
  assert.deepEqual(pouchNameParts('-- Timi --'), { firstName: 'Timi', lastName: 'User' });
  assert.deepEqual(pouchNameParts('Timi. Olowu, Jr!'), { firstName: 'Timi', lastName: 'Olowu Jr' });
});

test('overlong parts are capped', () => {
  const long = 'A'.repeat(120);
  const parts = pouchNameParts(`${long} ${long}`);
  assert.equal(parts.firstName.length, 50);
  assert.equal(parts.lastName.length, 50);
});
