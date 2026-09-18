import { selectMeanings } from '@/lib/vocabulary';

export async function GET(request: Request) {
  const word = new URL(request.url).searchParams.get('word')?.toLowerCase();
  if (!word || !/^[a-z]+(?:'[a-z]+)?$/.test(word)) return Response.json({ error: 'Invalid word' }, { status: 400 });
  const response = await fetch(`https://api.datamuse.com/words?sp=${encodeURIComponent(word)}&qe=sp&md=dp&max=1`);
  if (!response.ok) return Response.json({ word, meaning: '', partOfSpeech: '', example: '' });
  const [entry] = await response.json() as Array<{ word?: string; defs?: string[]; tags?: string[] }>;
  if (entry?.word?.toLowerCase() !== word) return Response.json({ word, meaning: '', partOfSpeech: '', example: '' });
  const selected = selectMeanings(entry.defs ?? []);
  const parts: Record<string, string> = { n: 'noun', v: 'verb', adj: 'adjective', adv: 'adverb', u: 'other' };
  const fallback = entry.tags?.find(tag => parts[tag]);
  return Response.json({ word, meanings: selected.meanings, partOfSpeech: parts[selected.partOfSpeech] ?? (fallback ? parts[fallback] : ''), example: '' });
}
