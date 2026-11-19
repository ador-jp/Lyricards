import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { dailyFallback, parseDictionaryPayload, parseSentencePayload, selectExample, selectMeanings } from './vocabulary.ts';

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

const source = readFileSync(new URL('../app/api/dictionary/route.ts', import.meta.url), 'utf8')
  .replace(/^import .*;\n/, '')
  .replace('export async function GET', 'async function GET');

async function lookup(dictionaryData: unknown, sentenceData: unknown, unavailable = false, invalidJson = false) {
  return await runInNewContext(`${stripTypeScriptTypes(source)}; GET(new Request('https://example.test/api/dictionary?word=dream'));`, {
    dailyFallback, parseDictionaryPayload, parseSentencePayload, selectExample, selectMeanings,
    Request, Response, URL, Promise, setTimeout: (callback: () => void) => { callback(); },
    fetch: async (url: string) => {
      const isDictionary = url.includes('datamuse');
      if (!isDictionary && unavailable) throw new Error('unavailable');
      return {
        ok: true,
        json: async () => {
          if (invalidJson) throw new SyntaxError('Invalid JSON');
          return isDictionary ? dictionaryData : sentenceData;
        },
      };
    },
  }) as Response;
}

void test('dictionary route returns controlled 502 errors for invalid dictionary payloads and JSON', async () => {
  for (const value of invalidDictionaries) {
    const response = await lookup(value, sentences);
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { error: 'Dictionary service unavailable' });
  }
  const response = await lookup(dictionary, sentences, false, true);
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { error: 'Dictionary service unavailable' });
});

void test('dictionary route preserves valid responses and uses fallback for invalid or unavailable sentences', async () => {
  const response = await lookup(dictionary, sentences);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    word: 'dream', meanings: ['A hope.'], partOfSpeech: 'noun', example: 'I have a dream.',
    exampleAuthor: 'author', exampleUrl: 'https://tatoeba.org/en/sentences/show/1',
  });
  for (const value of [...invalidSentences, { data: [] }]) {
    const fallback = await lookup(dictionary, value);
    assert.equal(fallback.status, 200);
    assert.deepEqual(await fallback.json(), {
      word: 'dream', meanings: ['A hope.'], partOfSpeech: 'noun',
      example: dailyFallback('dream', 'noun'), exampleAuthor: '', exampleUrl: '',
    });
  }
  const unavailable = await lookup(dictionary, null, true);
  assert.equal(unavailable.status, 200);
  assert.deepEqual(await unavailable.json(), {
    word: 'dream', meanings: ['A hope.'], partOfSpeech: 'noun',
    example: dailyFallback('dream', 'noun'), exampleAuthor: '', exampleUrl: '',
  });
  const empty = await lookup([], { data: [] });
  assert.equal(empty.status, 200);
  assert.deepEqual(await empty.json(), {
    word: 'dream', meanings: [], partOfSpeech: '', example: dailyFallback('dream', ''), exampleAuthor: '', exampleUrl: '',
  });
});

void test('dictionary cache reuses successful lookups, expires, and does not cache errors or empty results', async () => {
  let calls = 0;
  let now = 0;
  let mode = 'valid';
  const get = runInNewContext(`${stripTypeScriptTypes(source)}; GET`, {
    dailyFallback, parseDictionaryPayload, parseSentencePayload, selectExample, selectMeanings,
    Request, Response, URL, Promise, Date: { now: () => now },
    setTimeout: (callback: () => void) => { callback(); },
    fetch: async (url: string) => {
      calls += 1;
      return { ok: true, json: async () => url.includes('datamuse')
        ? mode === 'error' ? null : mode === 'empty' ? [] : mode === 'mismatch' ? [{ ...dictionary[0], word: 'dreamy' }] : dictionary
        : sentences };
    },
  }) as (request: Request) => Promise<Response>;
  const request = (word = 'dream') => new Request(`https://example.test/api/dictionary?word=${word}`);
  const first = await get(request());
  const second = await get(request('DREAM'));
  assert.deepEqual(await second.json(), await first.json());
  assert.equal(calls, 2);
  assert.equal((await get(request('123'))).status, 400);
  assert.equal(calls, 2);
  now += 3_600_001;
  await get(request());
  assert.equal(calls, 4);
  for (const nextMode of ['error', 'empty', 'mismatch']) {
    mode = nextMode;
    now += 3_600_001;
    const before: number = calls;
    for (let i = 0; i < 2; i += 1) assert.equal((await get(request())).status, mode === 'error' ? 502 : 200);
    assert.equal(calls, before + 4);
  }
});
