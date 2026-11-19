import { env } from 'cloudflare:workers';
import { isValidEntry } from '@/lib/entry';

type StoredEntry = { id: string; song: string; artist: string; words: unknown[]; createdAt: string };
const COOKIE = 'lyricards_owner';

function ownerId(request: Request) {
  const value = request.headers.get('Cookie')?.match(new RegExp(`${COOKIE}=([^;]+)`))?.[1];
  return value || crypto.randomUUID();
}

function response(body: unknown, owner: string, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'set-cookie': `${COOKIE}=${owner}; Path=/; Max-Age=31536000; SameSite=Lax; Secure` },
  });
}

export async function GET(request: Request) {
  const owner = ownerId(request);
  const db = (env as unknown as { DB?: D1Database }).DB;
  if (!db) return response({ error: '保存機能の準備中です。' }, owner, 503);
  const rows = await db.prepare('SELECT id, song, artist, words_json, created_at FROM entries WHERE owner_id = ? ORDER BY created_at DESC').bind(owner).all<{ id: string; song: string; artist: string; words_json: string; created_at: string }>();
  const entries: StoredEntry[] = rows.results.map(row => ({ id: row.id, song: row.song, artist: row.artist, words: JSON.parse(row.words_json), createdAt: row.created_at }));
  return response({ entries }, owner);
}

export async function POST(request: Request) {
  const owner = ownerId(request);
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    return response({ error: '保存する単語帳が不正です。' }, owner, 400);
  }
  if (!isValidEntry(value)) return response({ error: '保存する単語帳が不正です。' }, owner, 400);
  const db = (env as unknown as { DB?: D1Database }).DB;
  if (!db) return response({ error: '保存機能の準備中です。' }, owner, 503);
  await db.prepare('INSERT INTO entries (id, owner_id, song, artist, words_json, created_at) VALUES (?, ?, ?, ?, ?, ?)').bind(value.id, owner, value.song, value.artist, JSON.stringify(value.words), value.createdAt).run();
  return response({ saved: true }, owner, 201);
}
