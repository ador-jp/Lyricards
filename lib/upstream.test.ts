import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { GET as lookupDictionary } from '../app/api/dictionary/route.ts';
import { GET as lookupGenius } from '../app/api/genius/route.ts';
import { GET as searchSongs } from '../app/api/songs/route.ts';
import { dailyFallback } from './vocabulary.ts';

function mockUpstream(t: TestContext, respond: (host: string, expire: () => never) => Response) {
  const deadlines = new Map<AbortSignal, AbortController>();
  const timeout = t.mock.method(AbortSignal, 'timeout', (_delay: number) => {
    const controller = new AbortController();
    deadlines.set(controller.signal, controller);
    return controller.signal;
  });
  const fetch = t.mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
    return respond(new URL(url).hostname, () => {
      const controller = init?.signal && deadlines.get(init.signal);
      const reason = new DOMException('Upstream deadline exceeded', 'TimeoutError');
      controller?.abort(reason);
      throw reason;
    });
  });
  return (expectedHosts: string[]) => {
    assert.deepEqual(fetch.mock.calls.map(call => new URL(call.arguments[0]).hostname), expectedHosts);
    assert.deepEqual(timeout.mock.calls.map(call => call.arguments[0]), expectedHosts.map(() => 5_000));
    const requestSignals = fetch.mock.calls.map(call => call.arguments[1]?.signal);
    assert.deepEqual(requestSignals, [...deadlines.keys()]);
  };
}

void test('song search falls back when Deezer times out before headers', async t => {
  const song = { trackId: 1, trackName: 'Dream', artistName: 'Artist', artworkUrl100: 'cover', trackViewUrl: 'track' };
  const verifyRequests = mockUpstream(t, (host, expire) =>
    host === 'api.deezer.com' ? expire() : Response.json({ results: [song] }),
  );
  const response = await searchSongs(new Request('https://example.test/api/songs?q=dream'));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { results: [song] });
  verifyRequests(['api.deezer.com', 'itunes.apple.com']);
});

void test('Genius keeps its not-found response when the upstream body times out', async t => {
  const verifyRequests = mockUpstream(t, (_host, expire) => new Response(new ReadableStream({
    pull() {
      expire();
    },
  })));
  const response = await lookupGenius(new Request('https://example.test/api/genius?song=dream'));
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: 'No Genius lyrics page was found.' });
  verifyRequests(['genius.com']);
});

void test('dictionary retries a timed-out sentence request, then uses a local example', async t => {
  const verifyRequests = mockUpstream(t, (host, expire) => host === 'api.datamuse.com'
    ? Response.json([{ word: 'dream', defs: ['n\tA hope.'] }])
    : expire(),
  );
  const response = await lookupDictionary(new Request('https://example.test/api/dictionary?word=dream'));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    word: 'dream', meanings: ['A hope.'], partOfSpeech: 'noun',
    example: dailyFallback('dream', 'noun'), exampleAuthor: '', exampleUrl: '',
  });
  verifyRequests(['api.datamuse.com', 'api.tatoeba.org', 'api.tatoeba.org']);
});

void test('dictionary returns a controlled error after both definition requests time out', async t => {
  const verifyRequests = mockUpstream(t, (host, expire) => host === 'api.datamuse.com'
    ? expire()
    : Response.json({ data: [] }),
  );
  const response = await lookupDictionary(new Request('https://example.test/api/dictionary?word=dream'));
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { error: 'Dictionary service unavailable' });
  verifyRequests(['api.datamuse.com', 'api.tatoeba.org', 'api.datamuse.com']);
});
