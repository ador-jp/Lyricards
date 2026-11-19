import { isValidEntry, type Entry } from './entry.ts';

const STORAGE_KEY = 'lyricards.entries';
const LEGACY_STORAGE_KEYS = ['lylicards.entries', 'lyricbook.entries'];

export function mergeEntries(...lists: Entry[][]): Entry[] {
  const byId = new Map<string, Entry>();
  for (const entries of lists) {
    for (const entry of entries) {
      if (!byId.has(entry.id)) byId.set(entry.id, entry);
    }
  }
  return [...byId.values()].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

export function readCachedEntries(storage: Pick<Storage, 'getItem'>): Entry[] {
  for (const key of [STORAGE_KEY, ...LEGACY_STORAGE_KEYS]) {
    const raw = storage.getItem(key);
    if (raw === null) continue;
    try {
      const entries: unknown = JSON.parse(raw);
      if (Array.isArray(entries)) return entries.filter(entry => isValidEntry(entry, { enforceLimits: false }));
    } catch {
      // Try the legacy cache if the current one is unreadable.
    }
  }
  return [];
}

export function writeCachedEntries(storage: Pick<Storage, 'setItem'>, entries: Entry[]) {
  storage.setItem(STORAGE_KEY, JSON.stringify(entries));
}
