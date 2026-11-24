export type Word = { word: string; meaning?: string; meanings?: string[]; partOfSpeech?: string; example: string; exampleAuthor?: string; exampleUrl?: string };

type DictionaryEntry = { word?: string; defs?: string[]; tags?: string[] };
type Sentence = { id: number; text: string; owner?: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string');
}

export function parseDictionaryPayload(value: unknown): DictionaryEntry[] | null {
  if (!Array.isArray(value) || !value.every(item => isRecord(item)
    && (item.word === undefined || typeof item.word === 'string')
    && (item.defs === undefined || isStringArray(item.defs))
    && (item.tags === undefined || isStringArray(item.tags)))) return null;
  return value;
}

export function parseSentencePayload(value: unknown): Sentence[] {
  if (!isRecord(value) || !Array.isArray(value.data) || !value.data.every(item => isRecord(item)
    && typeof item.id === 'number' && Number.isFinite(item.id)
    && typeof item.text === 'string'
    && (item.owner === undefined || typeof item.owner === 'string'))) return [];
  return value.data;
}

const STOP = new Set('a an and are as at be been but by can did do for from had has have he her him his i if in into is it its me my no not of on or our out she so than that the their them there they this to up was we were what when where which who will with would you your'.split(' '));
const STOP_CONTRACTION = /^([a-z]+)'(?:m|s|re|ve|ll|d)$/;
const isStopWord = (word: string) => STOP.has(word) || STOP.has(STOP_CONTRACTION.exec(word)?.[1] ?? '');
const NOISE = /^(?:\[.*\]|\d*\s*embed|you might also like|contributors?|translations?|read more|see .* live|get tickets.*|sign up|log in)$/i;

export function cleanLyrics(text: string): string {
  return text.split(/\r?\n/).map(line => line.trim()).filter(line => line && !NOISE.test(line)).join('\n');
}

export function extractWords(text: string, excluded = new Set<string>()): Word[] {
  const lines = cleanLyrics(text).normalize('NFKD').replace(/\p{M}/gu, '').replace(/[\u2018\u2019\u02bc]/g, "'").split('\n');
  const counts = new Map<string, number>();
  for (const line of lines) for (const raw of line.toLowerCase().match(/[a-z]+(?:'[a-z]+)?/g) ?? []) {
    if (raw.length <= 2 || isStopWord(raw) || excluded.has(raw)) continue;
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

export function selectExample(word: string, sentences: Array<{ id: number; text: string; owner?: string }>) {
  const exact = new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
  const unsafe = /\b(?:fuck|shit|bitch|bastard|damn|Tom|Mary)\b/i;
  return sentences.filter(item => exact.test(item.text) && !unsafe.test(item.text)).sort((a, b) => {
    const score = (text: string) => (/\b(?:I|you|we|they|please|can|could|would)\b/i.test(text) ? 2 : 0) + (text.endsWith('?') ? 1 : 0) + (/^[A-Z][^.!?]{8,70}[.!?]$/.test(text) ? 1 : 0);
    return score(b.text) - score(a.text);
  })[0];
}

const EED_PAST = new Set(['agreed', 'decreed', 'disagreed', 'freed', 'guaranteed', 'refereed']);

export function dailyFallback(word: string, partOfSpeech: string) {
  if (/^(?:must|should|could|would|might|can|will)$/.test(word)) return `I ${word} finish this before dinner.`;
  if (partOfSpeech === 'noun') return `We talked about the ${word} over lunch.`;
  if (partOfSpeech === 'adjective') return `That sounds ${word} to me.`;
  if (partOfSpeech === 'adverb') return `She explained it ${word}.`;
  if (EED_PAST.has(word)) return `Could you use the word “${word}” in a sentence?`;
  if (word.endsWith('ed') && !word.endsWith('eed') && /[aeiouy]/.test(word.slice(0, -2))) return `Someone ${word} me after work.`;
  if (word.endsWith('ing') && /[aeiouy]/.test(word.slice(0, -3))) return `We talked about ${word} after work.`;
  if (partOfSpeech === 'verb') return `I often ${word} when I have time.`;
  return `Could you use the word “${word}” in a sentence?`;
}
