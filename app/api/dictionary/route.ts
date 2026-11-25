import { fetchUpstream } from '../../../lib/upstream.ts';
import { dailyFallback, parseDictionaryPayload, parseSentencePayload, selectExample, selectMeanings } from '../../../lib/vocabulary.ts';

const cache = new Map<string, { expiresAt: number; body: string }>();
const CACHE_TTL = 60 * 60 * 1000;
const CACHE_LIMIT = 500;

function delay(ms: number) {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

export async function GET(request: Request) {
  const word = new URL(request.url).searchParams.get('word')?.toLowerCase();
  if (!word || !/^[a-z]+(?:'[a-z]+)?$/.test(word)) return Response.json({ error: 'Invalid word' }, { status: 400 });
  const cached = cache.get(word);
  if (cached && cached.expiresAt > Date.now()) return new Response(cached.body, { headers: { 'content-type': 'application/json' } });
  cache.delete(word);

  const getJson = async (url: string) => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const response = await fetchUpstream(url);
        if (response.ok) return { available: true, data: await response.json() };
      } catch {
        // Retry transient upstream and JSON parsing failures once.
      }
      if (attempt === 0) await delay(200);
    }
    return { available: false, data: null };
  };
  const [dictionaryResult, sentenceResult] = await Promise.all([
    getJson(`https://api.datamuse.com/words?sp=${encodeURIComponent(word)}&qe=sp&md=dp&max=1`),
    getJson(`https://api.tatoeba.org/v1/sentences?lang=eng&q=${encodeURIComponent(word)}&is_unapproved=no&is_orphan=no&word_count=4-12&sort=relevance&limit=10`),
  ]);
  const entries = parseDictionaryPayload(dictionaryResult.data);
  if (!dictionaryResult.available || entries === null) {
    return Response.json({ error: 'Dictionary service unavailable' }, { status: 502 });
  }

  const [entry] = entries;
  const selected = selectMeanings(entry?.word?.toLowerCase() === word ? entry.defs ?? [] : []);
  const parts: Record<string, string> = { n: 'noun', v: 'verb', adj: 'adjective', adv: 'adverb', u: 'other' };
  const fallback = entry?.tags?.find(tag => parts[tag]);
  const partOfSpeech = parts[selected.partOfSpeech] ?? (fallback ? parts[fallback] : '');
  const sentences = parseSentencePayload(sentenceResult.data);
  const example = selectExample(word, sentences);

  const body = JSON.stringify({
    word,
    meanings: selected.meanings,
    partOfSpeech,
    example: example?.text ?? dailyFallback(word, partOfSpeech),
    exampleAuthor: example?.owner ?? '',
    exampleUrl: example ? `https://tatoeba.org/en/sentences/show/${example.id}` : '',
  });
  if (selected.meanings.length && sentenceResult.available && sentences.length) {
    if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value!);
    cache.set(word, { expiresAt: Date.now() + CACHE_TTL, body });
  }
  return new Response(body, { headers: { 'content-type': 'application/json' } });
}
