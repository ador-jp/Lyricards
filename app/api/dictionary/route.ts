import { selectMeanings } from '@/lib/vocabulary';

export async function GET(request: Request) {
  const word = new URL(request.url).searchParams.get('word')?.toLowerCase();
  if (!word || !/^[a-z]+(?:'[a-z]+)?$/.test(word)) return Response.json({ error: 'Invalid word' }, { status: 400 });
  const [response, sentenceResponse] = await Promise.all([
    fetch(`https://api.datamuse.com/words?sp=${encodeURIComponent(word)}&qe=sp&md=dp&max=1`),
    fetch(`https://api.tatoeba.org/v1/sentences?lang=eng&q=${encodeURIComponent(word)}&is_unapproved=no&is_orphan=no&word_count=4-12&sort=relevance&limit=10`),
  ]);
  if (!response.ok) return Response.json({ word, meaning: '', partOfSpeech: '', example: '' });
  const [entry] = await response.json() as Array<{ word?: string; defs?: string[]; tags?: string[] }>;
  if (entry?.word?.toLowerCase() !== word) return Response.json({ word, meaning: '', partOfSpeech: '', example: '' });
  const selected = selectMeanings(entry.defs ?? []);
  const parts: Record<string, string> = { n: 'noun', v: 'verb', adj: 'adjective', adv: 'adverb', u: 'other' };
  const fallback = entry.tags?.find(tag => parts[tag]);
  const sentences = sentenceResponse.ok ? await sentenceResponse.json() as { data?: Array<{ id: number; text: string; owner?: string }> } : {};
  const exact = sentences.data?.find(sentence => new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(sentence.text));
  return Response.json({ word, meanings: selected.meanings, partOfSpeech: parts[selected.partOfSpeech] ?? (fallback ? parts[fallback] : ''), example: exact?.text ?? '', exampleAuthor: exact?.owner ?? '', exampleUrl: exact ? `https://tatoeba.org/en/sentences/show/${exact.id}` : '' });
}
