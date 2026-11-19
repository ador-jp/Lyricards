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

export function readPendingEntries(storage: Pick<Storage, 'length' | 'key' | 'getItem'>, owner: string): Entry[] {
  const entries: Entry[] = [];
  const prefix = pendingPrefix(owner);
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (!key?.startsWith(prefix)) continue;
    const value = storage.getItem(key);
    if (!value) continue;
    try {
      const entry: unknown = JSON.parse(value);
      if (isValidEntry(entry) && key === pendingKey(owner, entry.id)) entries.push(entry);
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

export function saveResponseAction(status: number): 'saved' | 'reject' | 'retry' {
  if (status >= 200 && status < 300) return 'saved';
  if (status >= 400 && status < 500 && status !== 408 && status !== 429) return 'reject';
  return 'retry';
}

export async function syncPendingEntries(options: {
  storage: Pick<Storage, 'removeItem'>;
  owner: string;
  pending: Entry[];
  remote: Entry[];
  upload: (entry: Entry) => Promise<Response>;
  signal: AbortSignal;
  onRejected?: (entry: Entry) => void;
}) {
  const { storage, owner, pending, remote, upload, signal } = options;
  const savedIds = new Set(remote.map(entry => entry.id));
  for (const entry of pending) {
    if (signal.aborted) return;
    try {
      const action = savedIds.has(entry.id) ? 'saved' : saveResponseAction((await upload(entry)).status);
      if (signal.aborted) return;
      if (action !== 'retry') {
        storage.removeItem(pendingKey(owner, entry.id));
        // A 409 alone does not establish that the entry belongs to this owner.
        if (action === 'reject') options.onRejected?.(entry);
      }
    } catch {
      // Keep the pending save for the next reconnect or reload.
    }
  }
}
