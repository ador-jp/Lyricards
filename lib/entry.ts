import type { Word } from './vocabulary';

export type Entry = { id: string; song: string; artist: string; words: Word[]; createdAt: string };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isString(value: unknown, max: number, required = false): value is string {
  return typeof value === 'string' && value.length <= max && (!required || value.trim().length > 0);
}

function isWord(value: unknown, max: (limit: number) => number): value is Word {
  if (!isObject(value) || !isString(value.word, max(100), true) || !isString(value.example, max(4000))) return false;
  for (const [field, limit] of [['meaning', 4000], ['partOfSpeech', 100], ['exampleAuthor', 500], ['exampleUrl', 2000]] as const) {
    if (value[field] !== undefined && !isString(value[field], max(limit))) return false;
  }
  return value.meanings === undefined || (Array.isArray(value.meanings)
    && value.meanings.length <= max(20) && value.meanings.every(meaning => isString(meaning, max(4000))));
}

export function isValidEntry(value: unknown, { enforceLimits = true } = {}): value is Entry {
  const max = (limit: number) => enforceLimits ? limit : Infinity;
  return isObject(value)
    && isString(value.id, max(200), true)
    && isString(value.song, max(500), true)
    && isString(value.artist, max(500), true)
    && isString(value.createdAt, max(100), true)
    && Number.isFinite(Date.parse(value.createdAt))
    && Array.isArray(value.words)
    && value.words.length > 0
    && value.words.length <= max(1000)
    && value.words.every(word => isWord(word, max));
}
