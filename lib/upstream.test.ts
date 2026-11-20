import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test, { type TestContext } from 'node:test';
import { GET as lookupDictionary } from '../app/api/dictionary/route.ts';
import { GET as lookupGenius } from '../app/api/genius/route.ts';
import { GET as searchSongs } from '../app/api/songs/route.ts';
import { dailyFallback } from './vocabulary.ts';

function mockUpstream(t: TestContext, respond: (host: string, expire: () => never, url: URL) => Response) {
  const deadlines = new Map<AbortSignal, AbortController>();
  const hosts: string[] = [];
  const timeout = t.mock.method(AbortSignal, 'timeout', (_delay: number) => {
    const controller = new AbortController();
    deadlines.set(controller.signal, controller);
    return controller.signal;
  });
  const fetch = t.mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
    const parsedUrl = new URL(url);
    hosts.push(parsedUrl.hostname);
    return respond(parsedUrl.hostname, () => {
      const controller = init?.signal && deadlines.get(init.signal);
      const reason = new DOMException('Upstream deadline exceeded', 'TimeoutError');
      controller?.abort(reason);
      throw reason;
    }, parsedUrl);
  });
  return (expectedHosts: string[]) => {
    assert.deepEqual(hosts, expectedHosts);
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

for (const stalledHost of ['api.deezer.com', 'itunes.apple.com']) {
  void test(`song search returns an uncached error when ${stalledHost} times out and the other provider finds nothing`, async t => {
    const verifyRequests = mockUpstream(t, (host, expire) => {
      if (host === stalledHost) expire();
      return Response.json(host === 'api.deezer.com' ? { data: [] } : { results: [] });
    });
    const response = await searchSongs(new Request('https://example.test/api/songs?q=dream'));
    assert.equal(response.status, 502);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), { error: 'Song search is unavailable.' });
    verifyRequests(['api.deezer.com', 'itunes.apple.com']);
  });
}

void test('song search can cache empty results when both providers succeed', async t => {
  const verifyRequests = mockUpstream(t, host => Response.json(host === 'api.deezer.com' ? { data: [] } : { results: [] }));
  const response = await searchSongs(new Request('https://example.test/api/songs?q=dream'));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'public, max-age=60, s-maxage=300');
  assert.deepEqual(await response.json(), { results: [] });
  verifyRequests(['api.deezer.com', 'itunes.apple.com']);
});

void test('Genius tries the title-only query after the artist-qualified query times out', async t => {
  const queries: (string | null)[] = [];
  const url = 'https://genius.com/Artist-dream-lyrics';
  const verifyRequests = mockUpstream(t, (_host, expire, requestUrl) => {
    const query = requestUrl.searchParams.get('q');
    queries.push(query);
    if (query === 'dream Artist') expire();
    return Response.json({ response: { sections: [{ type: 'song', hits: [
      { type: 'song', result: { title: 'Dream', artist_names: 'Artist', url } },
    ] }] } });
  });
  const response = await lookupGenius(new Request('https://example.test/api/genius?song=dream&artist=Artist'));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), { url });
  assert.deepEqual(queries, ['dream Artist', 'dream']);
  verifyRequests(['genius.com', 'genius.com']);
});

for (const [song, artist, expectedQuery] of [
  ['Peaches (feat. Daniel Caesar & Giveon)', 'Justin Bieber', 'Peaches Justin Bieber'],
  ['Old Town Road (feat. Billy Ray Cyrus) (Remix)', 'Lil Nas X', 'Old Town Road Lil Nas X'],
  ['Stay [with Justin Bieber]', 'The Kid LAROI', 'Stay The Kid LAROI'],
  ['Here Comes The Sun - Remastered 2009', 'The Beatles', 'Here Comes The Sun The Beatles'],
]) {
  void test(`Genius matches "${song}" after dropping featured artists and version suffixes`, async t => {
    const queries: (string | null)[] = [];
    const title = expectedQuery.slice(0, -artist.length - 1);
    const url = `https://genius.com/${title.replace(/ /g, '-')}-lyrics`;
    const verifyRequests = mockUpstream(t, (_host, _expire, requestUrl) => {
      queries.push(requestUrl.searchParams.get('q'));
      return Response.json({ response: { sections: [{ type: 'song', hits: [
        { type: 'song', result: { title, artist_names: `${artist} (Ft. Someone)`, url } },
      ] }] } });
    });
    const response = await lookupGenius(new Request(`https://example.test/api/genius?song=${encodeURIComponent(song)}&artist=${encodeURIComponent(artist)}`));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { url });
    assert.deepEqual(queries, [expectedQuery]);
    verifyRequests(['genius.com']);
  });
}

for (const artistSearchTimesOut of [true, false]) {
  void test(`Genius distinguishes an incomplete search from no match (artist search times out: ${artistSearchTimesOut})`, async t => {
    const verifyRequests = mockUpstream(t, (_host, expire, url) => {
      if (artistSearchTimesOut && url.searchParams.get('q') === 'dream Artist') expire();
      return Response.json({ response: { sections: [] } });
    });
    const response = await lookupGenius(new Request('https://example.test/api/genius?song=dream&artist=Artist'));
    assert.equal(response.status, artistSearchTimesOut ? 502 : 404);
    assert.deepEqual(await response.json(), {
      error: artistSearchTimesOut ? 'Genius search is unavailable.' : 'No Genius lyrics page was found.',
    });
    verifyRequests(['genius.com', 'genius.com']);
  });
}

void test('Genius returns an upstream error when the response body times out', { timeout: 15_000 }, async t => {
  const upstream = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.write('{');
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  t.after(() => {
    upstream.close();
    upstream.closeAllConnections();
  });
  const address = upstream.address();
  assert.ok(address && typeof address !== 'string');

  const fetch = globalThis.fetch;
  let upstreamStatus: number | undefined;
  const redirectedFetch = t.mock.method(globalThis, 'fetch', async (_url: string, init?: RequestInit) => {
    const response = await fetch(`http://127.0.0.1:${address.port}`, init);
    upstreamStatus = response.status;
    return response;
  });
  const response = await lookupGenius(new Request('https://example.test/api/genius?song=dream'));
  assert.equal(upstreamStatus, 200, 'fetch received headers before the body timed out');
  const signal = redirectedFetch.mock.calls[0]?.arguments[1]?.signal;
  assert.ok(signal?.aborted && signal.reason instanceof DOMException);
  assert.equal(signal.reason.name, 'TimeoutError');
  assert.equal(response.status, 502);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), { error: 'Genius search is unavailable.' });
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
