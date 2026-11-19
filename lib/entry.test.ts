import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';
import { isValidEntry } from './entry.ts';

const valid = { id: 'entry-1', song: 'Song', artist: 'Artist', createdAt: '2026-01-01T00:00:00.000Z', words: [{ word: 'dream', example: '' }] };

void test('entry validation accepts minimal and enriched entries without changing them', () => {
  assert.equal(isValidEntry(valid), true);
  assert.equal(isValidEntry({ ...valid, words: [{ word: 'dream', example: 'I had a dream.', meaning: 'A hope.', meanings: ['A hope.'], partOfSpeech: 'noun', exampleAuthor: 'author', exampleUrl: 'https://tatoeba.org/en/sentences/show/1' }] }), true);
  assert.equal(isValidEntry({ ...valid, words: [{ word: 'dream', example: '', meanings: [] }] }), true);
});

const invalid: unknown[] = [null, [], 'entry', 42, true, {}, { ...valid, createdAt: 'not a date' }, { ...valid, words: [] }, { ...valid, words: [null] }, { ...valid, words: ['dream'] }];
for (const field of ['id', 'song', 'artist', 'createdAt']) {
  for (const value of [undefined, null, 1, '', '   ']) invalid.push({ ...valid, [field]: value });
}
for (const field of ['word', 'example', 'meaning', 'meanings', 'partOfSpeech', 'exampleAuthor', 'exampleUrl']) {
  for (const value of [null, 1, {}]) invalid.push({ ...valid, words: [{ ...valid.words[0], [field]: value }] });
}
for (const word of [{ example: '' }, { word: 'dream' }, { word: ' ', example: '' }, { word: 'dream', example: '', meanings: [null] }]) invalid.push({ ...valid, words: [word] });

void test('entry validation rejects invalid bodies and every malformed UI field', () => {
  for (const value of invalid) assert.equal(isValidEntry(value), false, JSON.stringify(value));
});

void test('entry validation enforces string and collection limits', () => {
  for (const [field, max] of [['id', 200], ['song', 500], ['artist', 500]] as const) {
    assert.equal(isValidEntry({ ...valid, [field]: 'x'.repeat(max) }), true);
    assert.equal(isValidEntry({ ...valid, [field]: 'x'.repeat(max + 1) }), false);
  }
  assert.equal(isValidEntry({ ...valid, createdAt: ' '.repeat(100) + valid.createdAt }), false);
  for (const [field, max] of [['word', 100], ['example', 4000], ['meaning', 4000], ['partOfSpeech', 100], ['exampleAuthor', 500], ['exampleUrl', 2000]] as const) {
    assert.equal(isValidEntry({ ...valid, words: [{ ...valid.words[0], [field]: 'x'.repeat(max) }] }), true);
    assert.equal(isValidEntry({ ...valid, words: [{ ...valid.words[0], [field]: 'x'.repeat(max + 1) }] }), false);
  }
  assert.equal(isValidEntry({ ...valid, words: Array(1000).fill(valid.words[0]) }), true);
  assert.equal(isValidEntry({ ...valid, words: Array(1001).fill(valid.words[0]) }), false);
  assert.equal(isValidEntry({ ...valid, words: [{ ...valid.words[0], meanings: Array(20).fill('x'.repeat(4000)) }] }), true);
  assert.equal(isValidEntry({ ...valid, words: [{ ...valid.words[0], meanings: Array(21).fill('meaning') }] }), false);
  assert.equal(isValidEntry({ ...valid, words: [{ ...valid.words[0], meanings: ['x'.repeat(4001)] }] }), false);
});

void test('POST rejects invalid JSON and entries without calling D1, and preserves valid inserts', async () => {
  const source = readFileSync(new URL('../app/api/entries/route.ts', import.meta.url), 'utf8')
    .replace("import { env } from 'cloudflare:workers';", `
      export const calls = [];
      const env = { DB: { prepare(sql) { calls.push(sql); return { bind(...values) {
        calls.push(values); return { async run() { calls.push('run'); } };
      } }; } } };
    `)
    .replace("'@/lib/entry'", JSON.stringify(new URL('./entry.ts', import.meta.url).href));
  const { POST, calls } = await import(`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source)).toString('base64')}`);
  for (const body of ['{', ...invalid.map(value => JSON.stringify(value))]) {
    const response = await POST(new Request('https://example.test/api/entries', { method: 'POST', body }));
    assert.equal(response.status, 400);
    assert.equal(typeof (await response.json()).error, 'string');
    assert.equal(calls.length, 0);
  }
  const response = await POST(new Request('https://example.test/api/entries', { method: 'POST', headers: { Cookie: 'lyricards_owner=owner-1' }, body: JSON.stringify(valid) }));
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), { saved: true });
  assert.deepEqual(calls[1], [valid.id, 'owner-1', valid.song, valid.artist, JSON.stringify(valid.words), valid.createdAt]);
  assert.equal(calls[2], 'run');
});
