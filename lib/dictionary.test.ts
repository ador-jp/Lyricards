import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { GET } from '../app/api/dictionary/route.ts';
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
