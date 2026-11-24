import { isValidEntry, type Entry } from './entry.ts';

function pendingPrefix(owner: string) {
  return `lyricards.pending:${encodeURIComponent(owner)}:`;
}

function pendingKey(owner: string, id: string) {
  return pendingPrefix(owner) + id;
}

function historyKey(owner: string) {
  return `lyricards.history:${encodeURIComponent(owner)}`;
}

export function mergeEntries(...lists: Entry[][]): Entry[] {
  const byId = new Map<string, Entry>();
  for (const entries of lists) {
    for (const entry of entries) {
      if (!byId.has(entry.id)) byId.set(entry.id, entry);
    }
  }
  return [...byId.values()].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

export function learnedWords(entries: Entry[], rejected: Entry[]): Set<string> {
  const rejectedIds = new Set(rejected.map(entry => entry.id));
  return new Set(entries.filter(entry => !rejectedIds.has(entry.id))
    .flatMap(entry => entry.words.map(item => item.word.toLowerCase())));
}

export function readPendingEntries(storage: Pick<Storage, 'length' | 'key' | 'getItem'>, owner: string): Entry[] {
  return readLocalEntries(storage, pendingPrefix(owner));
}

function rejectedPrefix(owner: string) {
  return `lyricards.rejected:${encodeURIComponent(owner)}:`;
}

export function readRejectedEntries(storage: Pick<Storage, 'length' | 'key' | 'getItem'>, owner: string): Entry[] {
  return readLocalEntries(storage, rejectedPrefix(owner));
}

export function discardRejectedEntries(storage: Pick<Storage, 'length' | 'key' | 'getItem' | 'removeItem'>, owner: string) {
  for (const entry of readRejectedEntries(storage, owner)) storage.removeItem(rejectedPrefix(owner) + entry.id);
}

function readLocalEntries(storage: Pick<Storage, 'length' | 'key' | 'getItem'>, prefix: string): Entry[] {
  const entries: Entry[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (!key?.startsWith(prefix)) continue;
    const value = storage.getItem(key);
    if (!value) continue;
    try {
      const entry: unknown = JSON.parse(value);
      if (isValidEntry(entry) && key === prefix + entry.id) entries.push(entry);
    } catch {
      // Ignore corrupt records without blocking other pending saves.
    }
  }
  return entries;
}

export function queueEntry(storage: Pick<Storage, 'setItem'>, owner: string, entry: Entry) {
  storage.setItem(pendingKey(owner, entry.id), JSON.stringify(entry));
}

export function readServerHistory(storage: Pick<Storage, 'getItem'>, owner: string): Entry[] {
  const raw = storage.getItem(historyKey(owner));
  if (!raw) return [];
  try {
    const entries: unknown = JSON.parse(raw);
    if (Array.isArray(entries)) return entries.filter(entry => isValidEntry(entry));
  } catch { /* Ignore an unreadable snapshot. */ }
  return [];
}

export function rememberServerEntries(storage: Pick<Storage, 'getItem' | 'setItem'>, owner: string, entries: Entry[]) {
  if (!entries.length) return;
  storage.setItem(historyKey(owner), JSON.stringify(mergeEntries(entries, readServerHistory(storage, owner))));
}

export function saveResponseAction(status: number): 'saved' | 'reject' | 'retry' | 'confirm' {
  if (status >= 200 && status < 300) return 'saved';
  if (status === 409) return 'confirm';
  if (status === 400 || status === 422) return 'reject';
  return 'retry';
}

export async function syncPendingEntries(options: {
  storage: Pick<Storage, 'removeItem' | 'setItem' | 'getItem'>;
  owner: string;
  pending: Entry[];
  remote: Entry[];
  upload: (entry: Entry) => Promise<Response>;
  signal: AbortSignal;
  onRejected?: (entry: Entry) => void;
  fetchRemote?: () => Promise<Entry[]>;
  onSaved?: (entry: Entry) => void;
}) {
  const { storage, owner, pending, remote, upload, signal } = options;
  const savedIds = new Set(remote.map(entry => entry.id));
  for (const entry of pending) {
    if (signal.aborted) return;
    try {
      let action = savedIds.has(entry.id) ? 'saved' : saveResponseAction((await upload(entry)).status);
      let savedEntry = remote.find(item => item.id === entry.id) ?? entry;
      if (action === 'confirm') {
        if (!options.fetchRemote) continue;
        const confirmed = (await options.fetchRemote()).find(item => item.id === entry.id);
        action = confirmed ? 'saved' : 'reject';
        if (confirmed) savedEntry = confirmed;
      }
      if (signal.aborted) return;
      if (action !== 'retry') {
        if (action === 'reject') storage.setItem(rejectedPrefix(owner) + entry.id, JSON.stringify(entry));
        if (action === 'saved') {
          try {
            rememberServerEntries(storage, owner, [savedEntry]);
          } catch { /* Confirmed saves do not require browser history storage. */ }
        }
        storage.removeItem(pendingKey(owner, entry.id));
        // A 409 alone does not establish that the entry belongs to this owner.
        if (action === 'reject') options.onRejected?.(entry);
        if (action === 'saved') options.onSaved?.(savedEntry);
      }
    } catch {
      // Keep the pending save for the next reconnect or reload.
    }
  }
}
