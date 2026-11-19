import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { mergeEntries, readCachedEntries, writeCachedEntries } from './entry-cache.ts';
import { isValidEntry } from './entry.ts';

const valid = { id: 'entry-1', song: 'Song', artist: 'Artist', createdAt: '2026-01-01T00:00:00.000Z', words: [{ word: 'dream', example: '' }] };

void test('merging the server history does not discard or duplicate browser saves', () => {
  const offline = { ...valid, id: 'offline', createdAt: '2026-01-02T00:00:00.000Z' };
  const remote = { ...valid, song: 'Server copy' };
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  };
  writeCachedEntries(storage, [valid, offline]);
  const merged = mergeEntries([remote], readCachedEntries(storage));
  assert.deepEqual(merged, [offline, remote]);
  writeCachedEntries(storage, merged);
  assert.deepEqual(readCachedEntries(storage), [offline, remote]);
});

void test('the cache reads older entries without applying current server size caps', () => {
  const large = { ...valid, words: Array(1001).fill(valid.words[0]) };
  const values = new Map([
    ['lyricards.entries', '{'],
    ['lylicards.entries', JSON.stringify([null, large])],
  ]);
  const storage = { getItem: (key: string) => values.get(key) ?? null };
  assert.deepEqual(readCachedEntries(storage), [large]);
  values.delete('lylicards.entries');
  values.set('lyricbook.entries', JSON.stringify([valid]));
  assert.deepEqual(readCachedEntries(storage), [valid]);
});

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
      export const state = { changes: 1, error: null };
      const env = { DB: { prepare(sql) { calls.push(sql); return { bind(...values) {
        calls.push(values); return { async run() {
          calls.push('run');
          if (state.error) throw state.error;
          return { meta: { changes: state.changes } };
        } };
      } }; } } };
    `)
    .replace("'@/lib/entry'", JSON.stringify(new URL('./entry.ts', import.meta.url).href));
  const { POST, calls, state } = await import(`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source)).toString('base64')}`);
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
  assert.match(calls[0], /ON CONFLICT\(id\) DO NOTHING$/);

  state.changes = 0;
  const duplicate = await POST(new Request('https://example.test/api/entries', { method: 'POST', body: JSON.stringify(valid) }));
  assert.equal(duplicate.status, 409);
  assert.deepEqual(await duplicate.json(), { error: 'この単語帳はすでに保存されています。' });

  for (const message of ['D1 unavailable', 'NOT NULL constraint failed: entries.song']) {
    state.error = new Error(message);
    const failure = await POST(new Request('https://example.test/api/entries', { method: 'POST', body: JSON.stringify(valid) }));
    assert.equal(failure.status, 500);
    assert.equal(typeof (await failure.json()).error, 'string');
  }
});

void test('save keeps a rejected draft and distinguishes validation from connectivity failures', async () => {
  const source = readFileSync(new URL('../app/page.tsx', import.meta.url), 'utf8');
  const save = source.slice(source.indexOf('  async function save()'), source.indexOf('  async function selectSong('));
  for (const [status, cacheAvailable] of [[201, false], [400, true], [409, true], [503, true], [503, false], [null, true]] as const) {
    const calls: Record<string, unknown[]> = {};
    const cached: unknown[] = [];
    const state: Record<string, unknown> = {
      selected: { trackName: 'Song', artistName: 'Artist' }, lyrics: 'dream', words: valid.words,
      geniusRequest: { current: 0 }, extractWords: () => valid.words, mergeEntries,
      cacheEntry: (entry: unknown) => { cached.push(entry); return cacheAvailable; },
      fetch: async () => {
        if (status === null) throw new TypeError('Offline');
        return new Response(null, { status });
      },
    };
    for (const name of ['setStatus', 'setSaving', 'setEntries', 'setQuery', 'setSongs', 'setSearchStatus', 'setSelected', 'setLyrics', 'setDetails', 'setGeniusUrl', 'setGeniusStatus', 'setGeniusLoading']) {
      calls[name] = [];
      state[name] = (value: unknown) => { calls[name].push(value); };
    }
    await runInNewContext(`${stripTypeScriptTypes(save)}; save();`, { ...state, crypto });
    assert.equal(calls.setSaving.at(-1), false);
    const rejected = status === 400 || status === 409;
    assert.equal(cached.length, rejected ? 0 : 1);
    if (rejected || (status !== 201 && !cacheAvailable)) {
      assert.equal(calls.setEntries.length, 0);
      assert.equal(calls.setLyrics.length, 0);
      assert.equal(calls.setSelected.length, 0);
      assert.match(String(calls.setStatus.at(-1)), status === 400 ? /保存条件/ : status === 409 ? /すでに保存されています/ : /入力を残したまま/);
    } else {
      assert.equal(calls.setEntries.length, 1);
      assert.deepEqual(calls.setLyrics, ['']);
      assert.match(String(calls.setStatus.at(-1)), status === 201 ? /語を保存しました/ : /このブラウザにのみ保存/);
    }
  }
});
