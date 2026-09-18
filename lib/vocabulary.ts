export type Word = { word: string; meaning?: string; meanings?: string[]; partOfSpeech?: string; example: string; exampleAuthor?: string; exampleUrl?: string };

const STOP = new Set('a an and are as at be been but by can did do for from had has have he her him his i if in into is it its me my no not of on or our out she so than that the their them there they this to up was we were what when where which who will with would you your'.split(' '));
const NOISE = /^(?:\[.*\]|\d*\s*embed|you might also like|contributors?|translations?|read more|see .* live|get tickets.*|sign up|log in)$/i;

export function cleanLyrics(text: string): string {
  return text.split(/\r?\n/).map(line => line.trim()).filter(line => line && !NOISE.test(line)).join('\n');
}

export function extractWords(text: string, excluded = new Set<string>()): Word[] {
  const lines = cleanLyrics(text).split('\n');
  const counts = new Map<string, number>();
  for (const line of lines) for (const raw of line.toLowerCase().match(/[a-z]+(?:'[a-z]+)?/g) ?? []) {
    if (raw.length <= 2 || STOP.has(raw) || excluded.has(raw)) continue;
    counts.set(raw, (counts.get(raw) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([word]) => ({ word, example: '' }));
}

export function selectMeanings(defs: string[], limit = 3): { meanings: string[]; partOfSpeech: string } {
  const parsed = defs.map(def => { const [partOfSpeech, meaning = ''] = def.split('\t', 2); return { partOfSpeech, meaning: meaning.trim() }; });
  const useful = parsed.filter(item => item.meaning && !/^(?:a\s+)?(?:surname|given name|family name)[.;]?$/i.test(item.meaning));
  const selected = (useful.length ? useful : parsed).filter(item => item.meaning).slice(0, limit);
  return { meanings: selected.map(item => item.meaning), partOfSpeech: selected[0]?.partOfSpeech ?? '' };
}
