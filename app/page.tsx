'use client';

import { useEffect, useMemo, useState } from 'react';
import { Download, ExternalLink, Music2, Search, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { extractWords, type Word } from '@/lib/vocabulary';

type Song = { trackId: number; trackName: string; artistName: string; artworkUrl100: string; trackViewUrl: string };
type Entry = { id: string; song: string; artist: string; words: Word[]; createdAt: string };

export default function Home() {
  const [query, setQuery] = useState('');
  const [songs, setSongs] = useState<Song[]>([]);
  const [selected, setSelected] = useState<Song | null>(null);
  const [lyrics, setLyrics] = useState('');
  const [entries, setEntries] = useState<Entry[]>(() => {
    if (typeof window === 'undefined') return [];
    try { return JSON.parse(localStorage.getItem('lyricbook.entries') || '[]'); } catch { return []; }
  });
  const [status, setStatus] = useState('');
  const words = useMemo(() => extractWords(lyrics), [lyrics]);

  useEffect(() => {
    const context = (document as Document & { modelContext?: { registerTool: (tool: object, options: { signal: AbortSignal }) => void } }).modelContext;
    if (!context?.registerTool) return;
    const lifecycle = new AbortController();
    context.registerTool({
      name: 'save_vocabulary_entry', title: '単語帳を保存',
      description: '曲名、アーティスト、英語歌詞から頻出語の単語帳をブラウザ内へ保存します。',
      inputSchema: { type: 'object', properties: { song: { type: 'string' }, artist: { type: 'string' }, lyrics: { type: 'string' } }, required: ['song', 'artist', 'lyrics'], additionalProperties: false },
      annotations: { readOnlyHint: false, untrustedContentHint: true },
      execute(input: unknown) {
        const value = input as { song?: string; artist?: string; lyrics?: string };
        if (!value.song?.trim() || !value.artist?.trim() || !value.lyrics?.trim()) throw new Error('song, artist, lyrics are required');
        const extracted = extractWords(value.lyrics);
        if (!extracted.length) throw new Error('No English words found');
        const entry = { id: crypto.randomUUID(), song: value.song, artist: value.artist, words: extracted, createdAt: new Date().toISOString() };
        setEntries(current => { const next = [entry, ...current]; localStorage.setItem('lyricbook.entries', JSON.stringify(next)); return next; });
        return { saved: extracted.length, song: value.song };
      },
    }, { signal: lifecycle.signal });
    return () => lifecycle.abort();
  }, []);

  async function searchSongs(e: React.FormEvent) {
    e.preventDefault();
    if (!query.trim()) return;
    setStatus('検索中…');
    try {
      const res = await fetch(`https://itunes.apple.com/search?media=music&entity=song&limit=6&term=${encodeURIComponent(query)}`);
      if (!res.ok) throw new Error();
      setSongs(((await res.json()) as { results: Song[] }).results);
      setStatus('');
    } catch { setStatus('検索できませんでした。通信環境を確認してください。'); }
  }

  function save() {
    if (!selected || !words.length) return setStatus('曲を選び、英語の歌詞を貼り付けてください。');
    const next = [{ id: crypto.randomUUID(), song: selected.trackName, artist: selected.artistName, words, createdAt: new Date().toISOString() }, ...entries];
    setEntries(next); localStorage.setItem('lyricbook.entries', JSON.stringify(next));
    setStatus(`${words.length}語をこの端末に保存しました。`);
  }

  function downloadCsv() {
    const rows = [['曲名', 'アーティスト', '単語', '例文', '保存日時'], ...entries.flatMap(e => e.words.map(w => [e.song, e.artist, w.word, w.example, e.createdAt]))];
    const csv = rows.map(row => row.map(v => `"${v.replaceAll('"', '""')}"`).join(',')).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' }));
    a.download = 'lyricbook.csv'; a.click(); URL.revokeObjectURL(a.href);
  }

  return <main className="min-h-screen bg-background text-foreground">
    <header className="border-b border-border/70 bg-card/80 backdrop-blur"><div className="mx-auto flex max-w-7xl items-center justify-between px-5 py-4">
      <div className="flex items-center gap-3"><span className="grid size-10 place-items-center rounded-xl bg-primary text-primary-foreground"><Music2 size={20}/></span><div><h1 className="text-lg font-bold tracking-tight">Lyricbook</h1><p className="text-xs text-muted-foreground">歌からつくる、自分だけの単語帳</p></div></div><span className="rounded-full bg-accent px-3 py-1 text-xs font-medium text-accent-foreground">MVP</span>
    </div></header>
    <div className="mx-auto grid max-w-7xl gap-6 px-5 py-7 lg:grid-cols-[minmax(0,1fr)_360px]">
      <section className="space-y-6">
        <div className="panel"><div className="step"><span>1</span><div><h2>曲を探す</h2><p>Apple Musicの公開メタデータから検索します。</p></div></div>
          <form onSubmit={searchSongs} className="mt-5 flex gap-2"><Input aria-label="曲名またはアーティスト" value={query} onChange={e => setQuery(e.target.value)} placeholder="例：Imagine John Lennon" className="h-11"/><Button type="submit" className="h-11 gap-2"><Search size={17}/>検索</Button></form>
          {songs.length > 0 && <div className="mt-4 grid gap-2 sm:grid-cols-2">{songs.map(song => <button key={song.trackId} onClick={() => setSelected(song)} className={`song ${selected?.trackId === song.trackId ? 'selected' : ''}`}><img src={song.artworkUrl100} alt=""/><span><strong>{song.trackName}</strong><small>{song.artistName}</small></span></button>)}</div>}
        </div>
        <div className="panel"><div className="step"><span>2</span><div><h2>歌詞を貼り付ける</h2><p>利用権のある歌詞だけを入力してください。歌詞本文は保存しません。</p></div></div>
          {selected && <div className="mt-4 flex items-center gap-3 rounded-xl bg-accent/60 p-3"><img className="size-11 rounded-lg" src={selected.artworkUrl100} alt=""/><div className="min-w-0 flex-1"><strong className="block truncate">{selected.trackName}</strong><span className="text-sm text-muted-foreground">{selected.artistName}</span></div><a aria-label="曲のページを開く" href={selected.trackViewUrl} target="_blank" rel="noreferrer"><ExternalLink size={18}/></a></div>}
          <Textarea value={lyrics} onChange={e => setLyrics(e.target.value)} className="mt-4 min-h-52 resize-y" placeholder="ここに英語の歌詞を貼り付け…"/><div className="mt-3 flex items-center justify-between text-sm text-muted-foreground"><span>{lyrics.length.toLocaleString()}文字</span><span>上位12語を抽出</span></div>
        </div>
      </section>
      <aside className="panel h-fit lg:sticky lg:top-6"><div className="step"><span>3</span><div><h2>単語帳にする</h2><p>頻出語と例文を確認して保存します。</p></div></div>
        <div className="mt-5 min-h-44 space-y-2">{words.length ? words.map(({word, example}) => <div className="word" key={word}><strong>{word}</strong><p>{example}</p></div>) : <div className="empty"><Sparkles size={26}/><p>歌詞を入力すると<br/>ここに単語が並びます</p></div>}</div>
        <Button onClick={save} disabled={!selected || !words.length} className="mt-5 h-11 w-full">単語帳に保存</Button>{status && <p role="status" className="mt-3 text-sm text-muted-foreground">{status}</p>}
        <div className="mt-6 border-t pt-5"><div className="flex items-center justify-between"><span className="text-sm font-semibold">保存済み</span><span className="text-sm text-muted-foreground">{entries.reduce((n, e) => n + e.words.length, 0)}語</span></div><Button variant="outline" onClick={downloadCsv} disabled={!entries.length} className="mt-3 w-full gap-2"><Download size={16}/>CSVを書き出す</Button><p className="mt-2 text-xs leading-relaxed text-muted-foreground">CSVはGoogle Sheetsでそのまま読み込めます。データはこのブラウザ内だけに保存されます。</p></div>
      </aside>
    </div>
  </main>;
}
