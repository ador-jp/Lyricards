import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';
import { GET, POST } from '../app/api/dictionary/route.ts';
import { dailyFallback, parseDictionaryPayload, parseSentencePayload } from './vocabulary.ts';

const dictionary = [{ word: 'dream', defs: ['n\tA hope.'], tags: ['n'] }];
const sentences = { data: [{ id: 1, text: 'I have a dream.', owner: 'author' }] };
const invalidDictionaries: unknown[] = [null, {}, 'dream', 1, [null], [[]], [1], [{ word: 1 }], [{ word: null }]];
for (const field of ['defs', 'tags']) {
  for (const value of [null, {}, 'n', 1, [null], [1], ['n', {}]]) {
    invalidDictionaries.push([{ ...dictionary[0], [field]: value }]);
  }
}
const invalidSentences: unknown[] = [null, [], 'text', {}, { data: {} }, { data: 'text' }, { data: null }];
for (const value of [null, [], 1, {}, { id: '1', text: 'I have a dream.' }, { id: 1, text: null }, { id: 1, text: 1 }, { id: 1, text: 'I have a dream.', owner: {} }]) {
  invalidSentences.push({ data: [value] }, { data: [...sentences.data, value] });
}

void test('dictionary payload parsing preserves valid and empty results and rejects malformed records', () => {
  assert.equal(parseDictionaryPayload(dictionary), dictionary);
  assert.deepEqual(parseDictionaryPayload([]), []);
  assert.deepEqual(parseDictionaryPayload([{}, { word: 'dream', defs: [], tags: [] }]), [{}, { word: 'dream', defs: [], tags: [] }]);
  for (const value of invalidDictionaries) assert.equal(parseDictionaryPayload(value), null);
});

void test('sentence payload parsing preserves valid results and falls back for malformed data', () => {
  assert.equal(parseSentencePayload(sentences), sentences.data);
  assert.deepEqual(parseSentencePayload({ data: [{ id: 2, text: 'We share a dream.' }] }), [{ id: 2, text: 'We share a dream.' }]);
  assert.deepEqual(parseSentencePayload({ data: [] }), []);
  for (const value of invalidSentences) assert.deepEqual(parseSentencePayload(value), []);
});

async function lookup(t: TestContext, dictionaryData: unknown, sentenceData: unknown, unavailable = false, invalidJson = false) {
  const fetch = t.mock.method(globalThis, 'fetch', async (url: string) => {
    const isDictionary = url.includes('datamuse');
    if (!isDictionary && unavailable) throw new Error('unavailable');
    if (invalidJson) return new Response('{');
    return Response.json(isDictionary ? dictionaryData : sentenceData);
  });
  try {
    return await GET(new Request('https://example.test/api/dictionary?word=dream'));
  } finally {
    fetch.mock.restore();
  }
}

void test('dictionary route returns controlled 502 errors for invalid dictionary payloads and JSON', async t => {
  for (const value of invalidDictionaries) {
    const response = await lookup(t, value, sentences);
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { error: 'Dictionary service unavailable' });
  }
  const response = await lookup(t, dictionary, sentences, false, true);
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { error: 'Dictionary service unavailable' });
});

void test('dictionary route preserves valid responses and uses fallback for invalid or unavailable sentences', async t => {
  const response = await lookup(t, dictionary, sentences);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    word: 'dream', meanings: ['A hope.'], partOfSpeech: 'noun', example: 'I have a dream.',
    exampleAuthor: 'author', exampleUrl: 'https://tatoeba.org/en/sentences/show/1',
  });
  for (const value of [...invalidSentences, { data: [] }]) {
    const fallback = await lookup(t, dictionary, value);
    assert.equal(fallback.status, 200);
    assert.deepEqual(await fallback.json(), {
      word: 'dream', meanings: ['A hope.'], partOfSpeech: 'noun',
      example: dailyFallback('dream', 'noun'), exampleAuthor: '', exampleUrl: '',
    });
  }
  const unavailable = await lookup(t, dictionary, null, true);
  assert.equal(unavailable.status, 200);
  assert.deepEqual(await unavailable.json(), {
    word: 'dream', meanings: ['A hope.'], partOfSpeech: 'noun',
    example: dailyFallback('dream', 'noun'), exampleAuthor: '', exampleUrl: '',
  });
  const empty = await lookup(t, [], { data: [] });
  assert.equal(empty.status, 200);
  assert.deepEqual(await empty.json(), {
    word: 'dream', meanings: [], partOfSpeech: '', example: dailyFallback('dream', ''), exampleAuthor: '', exampleUrl: '',
  });
});

void test('batch dictionary validates words before fetching', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', () => { throw new Error('Unexpected fetch'); });
  for (const value of [null, {}, { words: [] }, { words: ['dream', 1] }, { words: ['dream | world'] }, { words: ['a'.repeat(101)] }, { words: Array(21).fill('dream') }]) {
    const response = await POST(new Request('https://example.test/api/dictionary', { method: 'POST', body: JSON.stringify(value) }));
    assert.equal(response.status, 400);
  }
  assert.equal((await POST(new Request('https://example.test/api/dictionary', { method: 'POST', body: '{' }))).status, 400);
  assert.equal(fetch.mock.callCount(), 0);
});

void test('batch dictionary makes one filtered OR query and returns only fully enriched words', async t => {
  const urls: URL[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    const parsed = new URL(url);
    urls.push(parsed);
    return Response.json(parsed.hostname === 'api.tatoeba.org' ? sentences : [{ ...dictionary[0], word: parsed.searchParams.get('sp') }]);
  });
  const response = await POST(new Request('https://example.test/api/dictionary', { method: 'POST', body: JSON.stringify({ words: ['DREAM', 'world', 'dream'] }) }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { results: [{ word: 'dream', meanings: ['A hope.'], partOfSpeech: 'noun', example: 'I have a dream.', exampleAuthor: 'author', exampleUrl: 'https://tatoeba.org/en/sentences/show/1' }] });
  assert.equal(urls.length, 3);
  const query = urls.find(url => url.hostname === 'api.tatoeba.org')!;
  assert.equal(query.searchParams.get('q'), '(dream | world) (I | you | we | they | please | can | could | would)');
  for (const [key, value] of Object.entries({ lang: 'eng', is_unapproved: 'no', is_orphan: 'no', word_count: '4-12', sort: 'relevance', limit: '500' })) assert.equal(query.searchParams.get(key), value);
});

void test('batch dictionary leaves missing, malformed and unsafe examples for individual lookup', async t => {
  let sentenceData: unknown = sentences;
  let dictionaryData: unknown = dictionary;
  t.mock.method(globalThis, 'fetch', async (url: string) => Response.json(url.includes('datamuse') ? dictionaryData : sentenceData));
  const request = () => new Request('https://example.test/api/dictionary', { method: 'POST', body: JSON.stringify({ words: ['dream'] }) });
  for (const value of [{ data: [] }, ...invalidSentences, { data: [{ id: 1, text: 'Tom has a dream.' }] }, { data: [{ id: 1, text: 'We have dreams.' }] }]) {
    sentenceData = value;
    assert.deepEqual(await (await POST(request())).json(), { results: [] });
  }
  sentenceData = sentences;
  for (const value of [[], ...invalidDictionaries, [{ word: 'dream' }]]) {
    dictionaryData = value;
    assert.deepEqual(await (await POST(request())).json(), { results: [] });
  }
});

void test('batch dictionary returns a controlled error when sentence service fails', async t => {
  const calls: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    calls.push(url);
    return url.includes('datamuse') ? Response.json(dictionary) : new Response('', { status: 503 });
  });
  const response = await POST(new Request('https://example.test/api/dictionary', { method: 'POST', body: JSON.stringify({ words: ['dream'] }) }));
  assert.equal(response.status, 502);
  assert.equal(calls.filter(url => url.includes('tatoeba')).length, 1);
});

void test('batch deadline aborts upstream work without retrying', async t => {
  const controller = new AbortController();
  const timeouts: number[] = [];
  t.mock.method(AbortSignal, 'timeout', (ms: number) => { timeouts.push(ms); return controller.signal; });
  const calls: string[] = [];
  t.mock.method(globalThis, 'fetch', (url: string, init: RequestInit) => {
    calls.push(url);
    return new Promise<Response>((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    });
  });
  const pending = POST(new Request('https://example.test/api/dictionary', { method: 'POST', body: JSON.stringify({ words: ['dream'] }) }));
  await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  assert.equal((await pending).status, 502);
  assert.deepEqual(timeouts, [3_000]);
  assert.equal(calls.length, 2);
});

const page = readFileSync(new URL('../app/page.tsx', import.meta.url), 'utf8');
const fetchMeaningsSource = stripTypeScriptTypes(page.slice(page.indexOf('  async function fetchMeanings()'), page.indexOf('  function downloadCsv()')));

for (const batchState of ['success', 'empty', 'error']) {
  void test(`client batch ${batchState} preserves individual fallback and progress`, async () => {
    const details: Record<string, unknown> = {};
    const urls: string[] = [];
    const loading: boolean[] = [];
    const statuses: string[] = [];
    const result = { word: 'dream', meanings: ['A hope.'], partOfSpeech: 'noun', example: 'I have a dream.', exampleUrl: 'https://tatoeba.org/en/sentences/show/1' };
    await runInNewContext(`${fetchMeaningsSource}; fetchMeanings();`, {
      geniusRequest: { current: 0 },
      baseWords: [{ word: 'dream', example: '' }, { word: 'world', example: '' }],
      setLoading: (value: boolean) => loading.push(value),
      setStatus: (value: string) => statuses.push(value),
      setDetails: (update: (current: Record<string, unknown>) => Record<string, unknown>) => Object.assign(details, update(details)),
      AbortController, AbortSignal,
      setTimeout: (callback: () => void, ms: number) => { if (ms !== 15_000) queueMicrotask(callback); return 0; },
      clearTimeout: () => {},
      fetch: async (url: string) => {
        urls.push(url);
        if (url === '/api/dictionary') {
          if (batchState === 'error') throw new Error('Unavailable');
          return Response.json({ results: batchState === 'success' ? [result] : [] });
        }
        const word = new URL(url, 'https://example.test').searchParams.get('word');
        return Response.json({ ...result, word });
      },
    });
    assert.deepEqual(Object.keys(details).sort(), ['dream', 'world']);
    assert.deepEqual(loading, [true, false]);
    assert.equal(urls.length, batchState === 'success' ? 2 : 3);
    assert.match(statuses.at(-1)!, /^2語の意味と例文を取得しました/);
  });
}

void test('client skips empty lists and bounds batch sizes', async () => {
  const calls: number[] = [];
  for (const size of [0, 41]) {
    const baseWords = Array.from({ length: size }, (_, index) => ({ word: `word${index}`, example: '' }));
    await runInNewContext(`${fetchMeaningsSource}; fetchMeanings();`, {
      geniusRequest: { current: 0 },
      baseWords, setLoading: () => {}, setStatus: () => {}, setDetails: () => {},
      AbortController, AbortSignal, setTimeout: () => 0, clearTimeout: () => {},
      fetch: async (_url: string, init: RequestInit) => {
        const { words } = JSON.parse(init.body as string) as { words: string[] };
        calls.push(words.length);
        return Response.json({ results: words.map(word => ({ word, meanings: ['Meaning.'], partOfSpeech: 'noun', exampleUrl: 'https://tatoeba.org/en/sentences/show/1' })) });
      },
    });
    if (size === 0) assert.equal(calls.length, 0);
  }
  assert.deepEqual(calls, [20, 20, 1]);
});

for (const failure of ['http', 'timeout', 'empty', 'malformed']) {
  void test(`client ${failure} batch failure disables batches and restores four GET workers`, async () => {
    let posts = 0; let active = 0; let peak = 0;
    const waits: number[] = [];
    const details: Record<string, unknown> = {};
    const statuses: string[] = [];
    const timeouts: number[] = [];
    await runInNewContext(`${fetchMeaningsSource}; fetchMeanings();`, {
      geniusRequest: { current: 0 },
      baseWords: Array.from({ length: 30 }, (_, index) => ({ word: `word${index}`, example: '' })),
      setLoading: () => {}, setStatus: (value: string) => statuses.push(value),
      setDetails: (update: (current: Record<string, unknown>) => Record<string, unknown>) => Object.assign(details, update(details)),
      AbortController, AbortSignal: { timeout: (ms: number) => { timeouts.push(ms); return new AbortController().signal; } },
      Date: { now: () => 0 },
      setTimeout: (callback: () => void, ms: number) => { if (ms !== 15_000) { waits.push(ms); queueMicrotask(callback); } return 0; },
      clearTimeout: () => {},
      fetch: async (url: string) => {
        if (url === '/api/dictionary') {
          posts++;
          if (failure === 'timeout') throw new Error('Timeout');
          return Response.json(failure === 'malformed' ? null : { results: [] }, { status: failure === 'http' ? 502 : 200 });
        }
        active++; peak = Math.max(peak, active);
        await new Promise(resolve => setImmediate(resolve));
        active--;
        const word = new URL(url, 'https://example.test').searchParams.get('word');
        return Response.json({ word, meanings: ['A meaning.'], partOfSpeech: 'noun', example: 'An example.' });
      },
    });
    assert.equal(posts, 1);
    assert.equal(peak, 4);
    assert.deepEqual(waits.slice(0, 3), [1_100, 2_200, 3_300]);
    assert.equal(waits.length, 29);
    assert.deepEqual(timeouts, [3_500]);
    assert.equal(Object.keys(details).length, 30);
    assert.match(statuses.at(-1)!, /^30語の意味と例文を取得しました/);
  });
}

for (const staleAt of ['batch', 'json', 'get', 'pace']) {
  void test(`song switches during ${staleAt} stop dictionary updates and further requests`, async () => {
    const geniusRequest = { current: 0 };
    const details: unknown[] = [];
    const loading: boolean[] = [];
    const statuses: string[] = [];
    let posts = 0; let gets = 0;
    const result = { word: 'dream', meanings: ['A vision.'], partOfSpeech: 'noun', exampleUrl: 'https://tatoeba.org/en/sentences/show/1' };
    await runInNewContext(`${fetchMeaningsSource}; fetchMeanings();`, {
      geniusRequest,
      baseWords: Array.from({ length: 21 }, (_, index) => ({ word: index ? `word${index}` : 'dream', example: '' })),
      setDetails: (value: unknown) => details.push(value),
      setLoading: (value: boolean) => loading.push(value),
      setStatus: (value: string) => statuses.push(value),
      AbortController, AbortSignal, Date: { now: () => 0 }, clearTimeout: () => {},
      setTimeout: (callback: () => void, ms: number) => {
        if (ms !== 15_000) { geniusRequest.current++; queueMicrotask(callback); }
        return 0;
      },
      fetch: async (url: string) => {
        if (url === '/api/dictionary') {
          posts++;
          if (staleAt === 'batch') geniusRequest.current++;
          if (staleAt === 'pace') return Response.json({ error: 'Unavailable' }, { status: 502 });
          return { ok: true, json: async () => {
            if (staleAt === 'json') geniusRequest.current++;
            return { results: [result] };
          } };
        }
        gets++;
        if (staleAt === 'get') geniusRequest.current++;
        return Response.json(result);
      },
    });
    const stoppedInBatch = staleAt === 'batch' || staleAt === 'json';
    assert.equal(posts, stoppedInBatch || staleAt === 'pace' ? 1 : 2);
    assert.equal(gets, stoppedInBatch ? 0 : 1);
    assert.equal(details.length, stoppedInBatch ? 0 : staleAt === 'pace' ? 1 : 2);
    assert.equal(statuses.length, stoppedInBatch ? 1 : staleAt === 'pace' ? 2 : 3);
    assert.deepEqual(loading, [true]);
  });
}
