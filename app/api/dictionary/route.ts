import { fetchUpstream } from '../../../lib/upstream.ts';
import { dailyFallback, parseDictionaryPayload, parseSentencePayload, selectExample, selectMeanings } from '../../../lib/vocabulary.ts';

function delay(ms: number) {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

export async function GET(request: Request) {
  const word = new URL(request.url).searchParams.get('word')?.toLowerCase();
  if (!word || !/^[a-z]+(?:'[a-z]+)?$/.test(word)) return Response.json({ error: 'Invalid word' }, { status: 400 });

  const [dictionaryResult, sentenceResult] = await Promise.all([
    getJson(`https://api.datamuse.com/words?sp=${encodeURIComponent(word)}&qe=sp&md=dp&max=1`),
    getJson(`https://api.tatoeba.org/v1/sentences?lang=eng&q=${encodeURIComponent(word)}&is_unapproved=no&is_orphan=no&word_count=4-12&sort=relevance&limit=10`),
  ]);
  const entries = parseDictionaryPayload(dictionaryResult.data);
  if (!dictionaryResult.available || entries === null) {
    return Response.json({ error: 'Dictionary service unavailable' }, { status: 502 });
  }

  return Response.json(makeWord(word, entries[0], parseSentencePayload(sentenceResult.data)));
}

async function getJson(url: string, signal?: AbortSignal) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await (signal ? fetch(url, { headers: { accept: 'application/json' }, signal }) : fetchUpstream(url));
      if (response.ok) return { available: true, data: await response.json() };
    } catch {
      // Retry transient upstream and JSON parsing failures once.
    }
    if (signal) break;
    if (attempt === 0) await delay(200);
  }
  return { available: false, data: null };
}

function makeWord(word: string, entry: NonNullable<ReturnType<typeof parseDictionaryPayload>>[number] | undefined, sentences: ReturnType<typeof parseSentencePayload>) {
  const selected = selectMeanings(entry?.word?.toLowerCase() === word ? entry.defs ?? [] : []);
  const parts: Record<string, string> = { n: 'noun', v: 'verb', adj: 'adjective', adv: 'adverb', u: 'other' };
  const fallback = entry?.tags?.find(tag => parts[tag]);
  const partOfSpeech = parts[selected.partOfSpeech] ?? (fallback ? parts[fallback] : '');
  const example = selectExample(word, sentences);

  return {
    word,
    meanings: selected.meanings,
    partOfSpeech,
    example: example?.text ?? dailyFallback(word, partOfSpeech),
    exampleAuthor: example?.owner ?? '',
    exampleUrl: example ? `https://tatoeba.org/en/sentences/show/${example.id}` : '',
  };
}

export async function POST(request: Request) {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return Response.json({ error: 'Invalid words' }, { status: 400 });
  }
  const values = payload && typeof payload === 'object' && 'words' in payload ? payload.words : null;
  if (!Array.isArray(values) || !values.length || values.length > 20
    || !values.every((word): word is string => typeof word === 'string' && word.length <= 100 && /^[a-z]+(?:'[a-z]+)?$/i.test(word))) {
    return Response.json({ error: 'Invalid words' }, { status: 400 });
  }
  const words = [...new Set(values.map(word => word.toLowerCase()))];
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(3_000)]);
  const query = `(${words.join(' | ')}) (I | you | we | they | please | can | could | would)`;
  const sentencesPending = getJson(`https://api.tatoeba.org/v1/sentences?lang=eng&q=${encodeURIComponent(query)}&is_unapproved=no&is_orphan=no&word_count=4-12&sort=relevance&limit=500`, signal);
  const dictionaries = new Map<string, Awaited<ReturnType<typeof getJson>>>();
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(4, words.length) }, async () => {
    while (cursor < words.length && !signal.aborted) {
      const word = words[cursor++];
      dictionaries.set(word, await getJson(`https://api.datamuse.com/words?sp=${encodeURIComponent(word)}&qe=sp&md=dp&max=1`, signal));
    }
  }));
  const sentenceResult = await sentencesPending;
  if (!sentenceResult.available) return Response.json({ error: 'Sentence service unavailable' }, { status: 502 });
  const sentences = parseSentencePayload(sentenceResult.data);
  const results = words.flatMap(word => {
    const dictionary = dictionaries.get(word);
    const entries = dictionary?.available ? parseDictionaryPayload(dictionary.data) : null;
    if (!entries) return [];
    const result = makeWord(word, entries[0], sentences);
    return result.meanings.length && result.partOfSpeech && result.exampleUrl ? [result] : [];
  });
  return Response.json({ results });
}
