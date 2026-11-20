import { env } from 'cloudflare:workers';
import { isValidEntry, type Entry } from '@/lib/entry';
import { ENTRY_OWNER_HEADER, entryOwnerCookie, readEntryOwner } from '@/lib/entry-owner';

type StoredRow = { id: string; song: string; artist: string; words_json: string; created_at: string };

function storedEntry(row: StoredRow): Entry | null {
  try {
    const entry = { id: row.id, song: row.song, artist: row.artist, words: JSON.parse(row.words_json) as unknown, createdAt: row.created_at };
    return isValidEntry(entry) ? entry : null;
  } catch {
    return null;
  }
}

function response(body: unknown, status = 200, newOwner?: string) {
  const headers = new Headers({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'private, no-store' });
  if (newOwner) headers.set('set-cookie', entryOwnerCookie(newOwner));
  return new Response(JSON.stringify(body), { status, headers });
}

function ownerContext(request: Request) {
  const existing = readEntryOwner(request.headers.get('Cookie'));
  const expected = request.headers.get(ENTRY_OWNER_HEADER);
  if (expected !== null && expected !== existing) return null;
  const owner = existing ?? crypto.randomUUID();
  return { owner, reply: (body: unknown, status?: number) => response(body, status, existing ? undefined : owner) };
}

function ownerChanged() {
  return response({ error: 'ブラウザの保存先が変わりました。再試行してください。' }, 412);
}

export async function GET(request: Request) {
  const context = ownerContext(request);
  if (!context) return ownerChanged();
  const { owner, reply } = context;
  const db = (env as unknown as { DB?: D1Database }).DB;
  if (!db) return reply({ error: '保存機能の準備中です。' }, 503);
  let rows: StoredRow[];
  try {
    rows = (await db.prepare('SELECT id, song, artist, words_json, created_at FROM entries WHERE owner_id = ? ORDER BY created_at DESC').bind(owner).all<StoredRow>()).results;
  } catch {
    return reply({ error: '保存データを読み込めませんでした。再試行してください。' }, 500);
  }
  return reply({ entries: rows.map(storedEntry).filter(entry => entry !== null) });
}

export async function POST(request: Request) {
  const context = ownerContext(request);
  if (!context) return ownerChanged();
  const { owner, reply } = context;
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    return reply({ error: '保存する単語帳が不正です。' }, 400);
  }
  if (!isValidEntry(value)) return reply({ error: '保存する単語帳が不正です。' }, 400);
  const db = (env as unknown as { DB?: D1Database }).DB;
  if (!db) return reply({ error: '保存機能の準備中です。' }, 503);
  try {
    const result = await db.prepare('INSERT INTO entries (id, owner_id, song, artist, words_json, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING').bind(value.id, owner, value.song, value.artist, JSON.stringify(value.words), value.createdAt).run();
    if (result.meta.changes === 0) return reply({ error: 'この単語帳はすでに保存されています。' }, 409);
  } catch {
    return reply({ error: '単語帳を保存できませんでした。再試行してください。' }, 500);
  }
  return reply({ saved: true }, 201);
}
