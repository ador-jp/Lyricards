import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { discardRejectedEntries, learnedWords, mergeEntries, queueEntry, readPendingEntries, readRejectedEntries, readServerHistory, rememberServerEntries, saveResponseAction, syncPendingEntries } from './entry-cache.ts';
import { ENTRY_OWNER_HEADER, readEntryOwner } from './entry-owner.ts';
import { isValidEntry } from './entry.ts';
import { extractWords } from './vocabulary.ts';

const valid = { id: 'entry-1', song: 'Song', artist: 'Artist', createdAt: '2026-01-01T00:00:00.000Z', words: [{ word: 'dream', example: '' }] };

void test('learned words include saved and pending entries but not rejected entry ids', () => {
  const saved = { ...valid, id: 'saved', words: [{ word: 'Dream', example: '' }] };
  const pending = { ...valid, id: 'pending', words: [{ word: 'stars', example: '' }] };
  const rejected = { ...valid, words: [{ word: 'sunshine', example: '' }, { word: 'dream', example: '' }] };
  const entries = mergeEntries([saved, pending, rejected]);

  assert.deepEqual(learnedWords(entries, []), new Set(['dream', 'stars', 'sunshine']));
  const learned = learnedWords(entries, [{ ...rejected, words: [] }]);
  assert.deepEqual(learned, new Set(['dream', 'stars']));
  assert.deepEqual(extractWords('sunshine dream stars', learned).map(item => item.word), ['sunshine']);
  assert.deepEqual(learnedWords([], [rejected]), new Set());
  assert.deepEqual(learnedWords([rejected], [rejected]), new Set());
});

function makeStorage() {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    key: (index: number) => [...values.keys()][index] ?? null,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
}

void test('a new owner cannot see another owner’s pending or unscoped legacy entries', () => {
  const offline = { ...valid, id: 'offline', createdAt: '2026-01-02T00:00:00.000Z' };
  const remote = { ...valid, song: 'Server copy' };
  const storage = makeStorage();
  storage.setItem('lyricards.entries', JSON.stringify([valid]));
  queueEntry(storage, 'original-owner', offline);
  queueEntry(storage, 'original-owner', valid);
  queueEntry(storage, 'new-owner', { ...valid, song: 'New owner copy' });

  assert.deepEqual(mergeEntries([remote], readPendingEntries(storage, 'original-owner')), [offline, remote]);
  assert.deepEqual(readPendingEntries(storage, 'new-owner'), [{ ...valid, song: 'New owner copy' }]);
  assert.deepEqual(readPendingEntries(storage, 'unknown-owner'), []);
  assert.equal(readEntryOwner('other_lyricards_owner=wrong; lyricards_owner=right'), 'right');
});

void test('reconnect uploads pending saves once and retries unconfirmed entries', async () => {
  const owner = 'owner-1';
  const storage = makeStorage();
  const entries = ['present', 'offline', 'error', 'conflict', 'interrupted'].map(id => ({ ...valid, id }));
  for (const entry of entries) queueEntry(storage, owner, entry);
  queueEntry(storage, 'owner-2', { ...valid, id: 'offline' });
  const uploadAttempts: string[] = [];
  const run = (remote: typeof entries, statuses: Record<string, number>) => syncPendingEntries({
    storage, owner, pending: readPendingEntries(storage, owner), remote, signal: new AbortController().signal,
    fetchRemote: async () => remote,
    upload: async ({ id }) => {
      uploadAttempts.push(id);
      if (!(id in statuses)) throw new TypeError('Offline');
      return new Response(null, { status: statuses[id] });
    },
  });
  await run([entries[0]], { offline: 201, error: 503, conflict: 409 });
  assert.deepEqual(uploadAttempts, ['offline', 'error', 'conflict', 'interrupted']);
  assert.deepEqual(readPendingEntries(storage, owner), [entries[2], entries[4]]);
  assert.equal(readPendingEntries(storage, 'owner-2').length, 1);

  await run([entries[3]], { error: 201, interrupted: 201 });
  assert.deepEqual(uploadAttempts.slice(4), ['error', 'interrupted']);
  assert.deepEqual(readPendingEntries(storage, owner), []);
});

void test('save response decisions distinguish permanent rejection from retryable failures', () => {
  for (let status = 200; status < 300; status++) assert.equal(saveResponseAction(status), 'saved');
  for (let status = 400; status < 500; status++) {
    assert.equal(saveResponseAction(status), status === 409 ? 'confirm' : status === 400 || status === 422 ? 'reject' : 'retry');
  }
  for (let status = 500; status < 600; status++) assert.equal(saveResponseAction(status), 'retry');
  assert.equal(saveResponseAction(302), 'retry');
});

void test('sync reports and removes permanent rejections without retrying them or claiming ownership', async () => {
  for (const status of [400, 409, 422]) {
    const storage = makeStorage();
    queueEntry(storage, 'owner', valid);
    const rejected: unknown[] = [];
    let attempts = 0;
    const run = () => syncPendingEntries({
      storage, owner: 'owner', pending: readPendingEntries(storage, 'owner'), remote: [],
      signal: new AbortController().signal,
      fetchRemote: async () => [],
      upload: async () => { attempts++; return new Response(null, { status }); },
      onRejected: entry => rejected.push(entry),
    });
    await run();
    await run();
    assert.equal(attempts, 1);
    assert.deepEqual(rejected, [valid]);
    assert.deepEqual(readPendingEntries(storage, 'owner'), []);
    assert.deepEqual(readServerHistory(storage, 'owner'), []);
    assert.deepEqual(readRejectedEntries(storage, 'owner'), [valid]);
    assert.deepEqual(learnedWords(mergeEntries(readServerHistory(storage, 'owner'), [valid], readRejectedEntries(storage, 'owner')), readRejectedEntries(storage, 'owner')), new Set());
    assert.deepEqual(readRejectedEntries(storage, 'another-owner'), []);
    discardRejectedEntries(storage, 'another-owner');
    assert.deepEqual(readRejectedEntries(storage, 'owner'), [valid]);
    discardRejectedEntries(storage, 'owner');
    assert.deepEqual(readRejectedEntries(storage, 'owner'), []);
  }
});

void test('sync retains transient failures and does not mutate an aborted upload', async () => {
  for (const status of [401, 403, 404, 408, 429, 500, 503, null, 400]) {
    const storage = makeStorage();
    queueEntry(storage, 'owner', valid);
    const controller = new AbortController();
    await syncPendingEntries({
      storage, owner: 'owner', pending: [valid], remote: [], signal: controller.signal,
      upload: async () => {
        if (status === null) throw new TypeError('Offline');
        if (status === 400) controller.abort();
        return new Response(null, { status });
      },
      onRejected: () => assert.fail('Must not report a rejection'),
    });
    assert.deepEqual(readPendingEntries(storage, 'owner'), [valid]);
    assert.deepEqual(learnedWords(readPendingEntries(storage, 'owner'), readRejectedEntries(storage, 'owner')), new Set(['dream']));
  }
});

void test('owner mismatch preserves the pending save until its owner can retry', async () => {
  const storage = makeStorage();
  queueEntry(storage, 'owner-1', valid);
  const rejected: unknown[] = [];
  const run = (status: number) => syncPendingEntries({
    storage, owner: 'owner-1', pending: readPendingEntries(storage, 'owner-1'), remote: [],
    signal: new AbortController().signal,
    upload: async () => new Response(null, { status }),
    onRejected: entry => rejected.push(entry),
  });
  await run(412);
  assert.deepEqual(readPendingEntries(storage, 'owner-1'), [valid]);
  assert.deepEqual(readPendingEntries(storage, 'owner-2'), []);
  assert.deepEqual(rejected, []);
  await run(201);
  assert.deepEqual(readPendingEntries(storage, 'owner-1'), []);
  assert.deepEqual(rejected, []);
});

void test('409 checks owner history and caches the server copy saved by another tab', async () => {
  for (const outcome of ['saved', 'missing', 'failure', 'aborted'] as const) {
    const storage = makeStorage();
    queueEntry(storage, 'owner', valid);
    const serverCopy = { ...valid, song: 'Server copy' };
    const rejected: unknown[] = [];
    const saved: unknown[] = [];
    const controller = new AbortController();
    await syncPendingEntries({
      storage, owner: 'owner', pending: [valid], remote: [], signal: controller.signal,
      upload: async () => new Response(null, { status: 409 }),
      fetchRemote: async () => {
        if (outcome === 'failure') throw new Error('GET failed');
        if (outcome === 'aborted') controller.abort();
        return outcome === 'saved' ? [serverCopy] : [];
      },
      onRejected: entry => rejected.push(entry), onSaved: entry => saved.push(entry),
    });
    assert.deepEqual(readPendingEntries(storage, 'owner'), outcome === 'failure' || outcome === 'aborted' ? [valid] : []);
    assert.deepEqual(readServerHistory(storage, 'owner'), outcome === 'saved' ? [serverCopy] : []);
    assert.deepEqual(saved, outcome === 'saved' ? [serverCopy] : []);
    assert.deepEqual(readRejectedEntries(storage, 'owner'), outcome === 'missing' ? [valid] : []);
    assert.deepEqual(rejected, outcome === 'missing' ? [valid] : []);
  }
});

void test('failure to archive a rejected entry preserves its pending copy', async () => {
  const storage = makeStorage();
  queueEntry(storage, 'owner', valid);
  const rejected: unknown[] = [];
  await syncPendingEntries({
    storage: { ...storage, setItem: () => { throw new Error('Storage full'); } },
    owner: 'owner', pending: [valid], remote: [], signal: new AbortController().signal,
    upload: async () => new Response(null, { status: 400 }), onRejected: entry => rejected.push(entry),
  });
  assert.deepEqual(readPendingEntries(storage, 'owner'), [valid]);
  assert.deepEqual(rejected, []);
});

void test('history cache failure does not retain confirmed saves in the pending queue', async () => {
  for (const status of [201, 409]) {
    const storage = makeStorage();
    queueEntry(storage, 'owner', valid);
    const saved: unknown[] = [];
    await syncPendingEntries({
      storage: { ...storage, setItem: () => { throw new Error('Storage full'); } },
      owner: 'owner', pending: [valid], remote: [], signal: new AbortController().signal,
      upload: async () => new Response(null, { status }), fetchRemote: async () => [valid],
      onSaved: entry => saved.push(entry), onRejected: () => assert.fail('Already saved'),
    });
    assert.deepEqual(readPendingEntries(storage, 'owner'), []);
    assert.deepEqual(saved, [valid]);
    assert.deepEqual(readServerHistory(storage, 'owner'), []);
  }
});

void test('offline history restores confirmed saves for that owner without adding them to the upload queue', () => {
  const storage = makeStorage();
  const synced = { ...valid, id: 'synced', createdAt: '2026-01-02T00:00:00.000Z' };
  rememberServerEntries(storage, 'owner-1', [valid]);
  rememberServerEntries(storage, 'owner-1', [synced]);
  rememberServerEntries(storage, 'owner-2', []);
  assert.deepEqual(readServerHistory(storage, 'owner-1'), [synced, valid]);
  assert.deepEqual(readPendingEntries(storage, 'owner-1'), []);
  assert.deepEqual(readServerHistory(storage, 'owner-2'), []);
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
    .replace("'@/lib/entry'", JSON.stringify(new URL('./entry.ts', import.meta.url).href))
    .replace("'@/lib/entry-owner'", JSON.stringify(new URL('./entry-owner.ts', import.meta.url).href));
  const { GET, POST, calls, state } = await import(`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source)).toString('base64')}`);
  for (const cookie of ['', 'lyricards_owner=owner-2']) {
    const headers = { cookie, [ENTRY_OWNER_HEADER]: 'owner-1' };
    const get = await GET(new Request('https://example.test/api/entries', { headers }));
    const post = await POST(new Request('https://example.test/api/entries', { method: 'POST', headers, body: JSON.stringify(valid) }));
    assert.equal(get.status, 412);
    assert.equal(post.status, 412);
    assert.equal(get.headers.get('set-cookie'), null);
    assert.equal(post.headers.get('set-cookie'), null);
    assert.equal(calls.length, 0);
  }
  for (const body of ['{', ...invalid.map(value => JSON.stringify(value))]) {
    const response = await POST(new Request('https://example.test/api/entries', { method: 'POST', body }));
    assert.equal(response.status, 400);
    assert.equal(typeof (await response.json()).error, 'string');
    assert.equal(calls.length, 0);
  }
  const response = await POST(new Request('https://example.test/api/entries', { method: 'POST', headers: { cookie: 'lyricards_owner=owner-1', [ENTRY_OWNER_HEADER]: 'owner-1' }, body: JSON.stringify(valid) }));
  assert.equal(response.status, 201);
  assert.equal(response.headers.get('set-cookie'), null);
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
  for (const [status, cacheAvailable, currentOwner = 'owner-1'] of [[201, false], [400, true], [409, true], [412, true], [503, true], [503, false], [null, true], [null, true, 'owner-2']] as const) {
    const calls: Record<string, unknown[]> = {};
    const cached: unknown[] = [];
    const state: Record<string, unknown> = {
      selected: { trackName: 'Song', artistName: 'Artist' }, lyrics: 'dream', words: valid.words,
      geniusRequest: { current: 0 }, extractWords: () => valid.words, mergeEntries, isValidEntry,
      invalidEntryMessage: '保存条件', ownerChangedMessage: '保存先が変わりました', pendingSaveMessage: 'サーバーへの保存を再試行',
      ensureEntryOwner: () => 'owner-1', document: { cookie: `lyricards_owner=${currentOwner}` }, readEntryOwner,
      cacheServerEntries: () => {}, setSyncWarning: () => {},
      savePendingEntry: (owner: string, entry: unknown) => {
        assert.equal(owner, 'owner-1');
        cached.push(entry);
        return cacheAvailable;
      },
      postEntry: async () => {
        if (status === null) throw new TypeError('Offline');
        return new Response(null, { status });
      },
    };
    for (const name of ['setStatus', 'setSaving', 'setHistory', 'setQuery', 'setSongs', 'setSearchStatus', 'setSelected', 'setLyrics', 'setDetails', 'setGeniusUrl', 'setGeniusStatus', 'setGeniusLoading', 'setLoading']) {
      calls[name] = [];
      state[name] = (value: unknown) => { calls[name].push(value); };
    }
    await runInNewContext(`${stripTypeScriptTypes(save)}; save();`, { ...state, crypto });
    assert.equal(calls.setSaving.at(-1), false);
    const ownerChanged = status === 412 || currentOwner !== 'owner-1';
    const rejected = status === 400 || status === 409 || ownerChanged;
    assert.equal(cached.length, rejected || status === 201 ? 0 : 1);
    if (rejected || (status !== 201 && !cacheAvailable)) {
      assert.equal(calls.setHistory.length, 0);
      assert.equal(calls.setLyrics.length, 0);
      assert.equal(calls.setSelected.length, 0);
      assert.match(String(calls.setStatus.at(-1)), status === 400 ? /保存条件/ : status === 409 ? /すでに保存されています/ : ownerChanged ? /保存先が変わりました/ : /入力を残したまま/);
    } else {
      assert.equal(calls.setHistory.length, 1);
      assert.deepEqual(calls.setLyrics, ['']);
      assert.match(String(calls.setStatus.at(-1)), status === 201 ? /語を保存しました/ : /サーバーへの保存を再試行/);
    }
  }
});

void test('a save that finishes after another song was chosen keeps the new song and its lyrics', async () => {
  const source = readFileSync(new URL('../app/page.tsx', import.meta.url), 'utf8');
  const save = source.slice(source.indexOf('  async function save()'), source.indexOf('  async function selectSong('));
  const calls: Record<string, unknown[]> = {};
  const geniusRequest = { current: 0 };
  const state: Record<string, unknown> = {
    selected: { trackName: 'Song', artistName: 'Artist' }, lyrics: 'dream', words: valid.words,
    geniusRequest, extractWords: () => valid.words, mergeEntries, isValidEntry,
    invalidEntryMessage: '保存条件', ownerChangedMessage: '保存先が変わりました', pendingSaveMessage: 'サーバーへの保存を再試行',
    ensureEntryOwner: () => 'owner-1', document: { cookie: 'lyricards_owner=owner-1' }, readEntryOwner,
    cacheServerEntries: () => {}, setSyncWarning: () => {}, savePendingEntry: () => true,
    postEntry: async () => {
      geniusRequest.current += 1;
      return new Response(null, { status: 201 });
    },
  };
  for (const name of ['setStatus', 'setSaving', 'setHistory', 'setQuery', 'setSongs', 'setSearchStatus', 'setSelected', 'setLyrics', 'setDetails', 'setGeniusUrl', 'setGeniusStatus', 'setGeniusLoading', 'setLoading']) {
    calls[name] = [];
    state[name] = (value: unknown) => { calls[name].push(value); };
  }
  await runInNewContext(`${stripTypeScriptTypes(save)}; save();`, { ...state, crypto });
  assert.equal(calls.setHistory.length, 1);
  assert.equal(geniusRequest.current, 1);
  for (const name of ['setSelected', 'setLyrics', 'setDetails', 'setQuery', 'setSongs', 'setGeniusUrl']) assert.equal(calls[name].length, 0, name);
  assert.match(String(calls.setStatus.at(-1)), /語を保存しました/);
  assert.equal(calls.setSaving.at(-1), false);
});

void test('a song search answered after the query was edited does not show its results or keep the button disabled', async () => {
  const source = readFileSync(new URL('../app/page.tsx', import.meta.url), 'utf8');
  const searchSongs = source.slice(source.indexOf('  async function searchSongs('), source.indexOf('  async function save()'));
  assert.match(source, /onChange=\{e => \{ searchRequest\.current \+= 1; setSearching\(false\);/);
  for (const [edited, ok] of [[false, true], [true, true], [false, false], [true, false]] as const) {
    const calls: Record<string, unknown[]> = { setSongs: [], setSearchStatus: [], setSearching: [] };
    const searchRequest = { current: 0 };
    const state: Record<string, unknown> = {
      query: 'yesterday', searchRequest, encodeURIComponent,
      fetch: async () => {
        if (edited) searchRequest.current += 1;
        if (!ok) throw new TypeError('Offline');
        return Response.json({ results: [{ trackId: 1, trackName: 'Yesterday', artistName: 'The Beatles', artworkUrl100: '', trackViewUrl: '' }] });
      },
    };
    for (const name of Object.keys(calls)) state[name] = (value: unknown) => { calls[name].push(value); };
    await runInNewContext(`${stripTypeScriptTypes(searchSongs)}; searchSongs({ preventDefault() {} });`, state);
    assert.deepEqual(calls.setSearching, edited ? [true] : [true, false]);
    assert.equal(calls.setSongs.length, edited || !ok ? 0 : 1);
    assert.deepEqual(calls.setSearchStatus, edited ? ['検索中…'] : ['検索中…', ok ? '' : '曲の検索サービスに接続できませんでした。少し待って再試行してください。']);
  }
});

void test('dictionary lookups from a previous song stop updating the page once another song is chosen', async () => {
  const source = readFileSync(new URL('../app/page.tsx', import.meta.url), 'utf8');
  const fetchMeanings = source.slice(source.indexOf('  async function fetchMeanings()'), source.indexOf('  function downloadCsv()'));
  for (const switchSong of [false, true]) {
    const calls: Record<string, unknown[]> = { setDetails: [], setStatus: [], setLoading: [] };
    const geniusRequest = { current: 0 };
    const state: Record<string, unknown> = {
      baseWords: [{ word: 'dream', example: '' }, { word: 'night', example: '' }], geniusRequest, setTimeout, clearTimeout, AbortController,
      fetch: async () => {
        if (switchSong) geniusRequest.current += 1;
        return Response.json({ word: 'dream', meaning: 'A vision.', partOfSpeech: 'noun', example: 'I had a dream.' });
      },
    };
    for (const name of Object.keys(calls)) state[name] = (value: unknown) => { calls[name].push(value); };
    await runInNewContext(`${stripTypeScriptTypes(fetchMeanings)}; fetchMeanings();`, state);
    if (switchSong) {
      assert.equal(calls.setDetails.length, 0);
      assert.deepEqual(calls.setLoading, [true]);
      assert.equal(calls.setStatus.length, 1);
    } else {
      assert.equal(calls.setDetails.length, 2);
      assert.deepEqual(calls.setLoading, [true, false]);
      assert.match(String(calls.setStatus.at(-1)), /2語の意味と例文を取得しました/);
    }
  }
});

void test('GET skips unreadable stored entries and returns a controlled error when D1 fails', async () => {
  const source = readFileSync(new URL('../app/api/entries/route.ts', import.meta.url), 'utf8')
    .replace("import { env } from 'cloudflare:workers';", `
      export const state = { rows: [], error: null, owner: null };
      const env = { DB: { prepare() { return { bind(owner) {
        state.owner = owner;
        return { async all() {
          if (state.error) throw state.error;
          return { results: state.rows };
        } };
      } }; } } };
    `)
    .replace("'@/lib/entry'", JSON.stringify(new URL('./entry.ts', import.meta.url).href))
    .replace("'@/lib/entry-owner'", JSON.stringify(new URL('./entry-owner.ts', import.meta.url).href));
  const { GET, state } = await import(`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source)).toString('base64')}`);
  const row = (id: string, words_json: string, created_at = valid.createdAt) => ({ id, song: valid.song, artist: valid.artist, words_json, created_at });
  const headers = { cookie: 'lyricards_owner=owner-1', [ENTRY_OWNER_HEADER]: 'owner-1' };
  state.rows = [
    row('good', JSON.stringify(valid.words)),
    row('truncated', '[{"word":"dream"'),
    row('not-array', '{"word":"dream"}'),
    row('empty', '[]'),
    row('bad-word', JSON.stringify([{ word: 42, example: '' }])),
    row('bad-date', JSON.stringify(valid.words), 'not a date'),
  ];
  const response = await GET(new Request('https://example.test/api/entries', { headers }));
  assert.equal(response.status, 200);
  assert.equal(state.owner, 'owner-1');
  assert.deepEqual(await response.json(), { entries: [{ ...valid, id: 'good' }] });

  state.error = new Error('D1 unavailable');
  const failure = await GET(new Request('https://example.test/api/entries', { headers }));
  assert.equal(failure.status, 500);
  assert.equal(failure.headers.get('cache-control'), 'private, no-store');
  assert.equal(typeof (await failure.json()).error, 'string');
});
