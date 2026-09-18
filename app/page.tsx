'use client';

import { useEffect, useMemo, useState } from 'react';
import { Download, ExternalLink, LoaderCircle, Music2, Search, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { extractWords, type Word } from '@/lib/vocabulary';

type Song = { trackId: number; trackName: string; artistName: string; artworkUrl100: string; trackViewUrl: string };
type Entry = { id: string; song: string; artist: string; words: Word[]; createdAt: string };
const STORAGE_KEY = 'lylicards.entries';

export default function Home() {
  const [query, setQuery] = useState('');
  const [songs, setSongs] = useState<Song[]>([]);
  const [selected, setSelected] = useState<Song | null>(null);
  const [lyrics, setLyrics] = useState('');
  const [entries, setEntries] = useState<Entry[]>(() => {
    if (typeof window === 'undefined') return [];
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || localStorage.getItem('lyricbook.entries') || '[]'); } catch { return []; }
  });
  const [status, setStatus] = useState('');
  const [excludeLearned, setExcludeLearned] = useState(true);
  const [details, setDetails] = useState<Record<string, Partial<Word>>>({});
  const [loading, setLoading] = useState(false);
  const learned = useMemo(() => new Set(entries.flatMap(entry => entry.words.map(item => item.word.toLowerCase()))), [entries]);
  const baseWords = useMemo(() => extractWords(lyrics, excludeLearned ? learned : new Set()), [lyrics, excludeLearned, learned]);
  const words = useMemo(() => baseWords.map(item => ({ ...item, ...details[item.word], example: details[item.word]?.example || item.example })), [baseWords, details]);

  useEffect(() => {
    if (query.trim().length < 2) { setSongs([]); return; }
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`https://itunes.apple.com/search?media=music&entity=song&limit=6&term=${encodeURIComponent(query)}`, { signal: controller.signal });
        if (res.ok) setSongs(((await res.json()) as { results: Song[] }).results);
      } catch (error) { if ((error as Error).name !== 'AbortError') setStatus('候補を取得できませんでした。'); }
    }, 350);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [query]);

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
        setEntries(current => { const next = [entry, ...current]; localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); return next; });
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
    setEntries(next); localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    setStatus(`${words.length}語をこの端末に保存しました。`);
  }

  function selectSong(song: Song) {
    setSelected(song); setLyrics('');
    setStatus('曲を選択しました。歌詞の自動取得にはライセンス済みAPIの契約が必要です。');
  }

  async function fetchMeanings() {
    setLoading(true); setStatus(`0 / ${baseWords.length}語を取得中…`);
    let done = 0;
    for (let i = 0; i < baseWords.length; i += 5) {
      const batch = await Promise.all(baseWords.slice(i, i + 5).map(async item => {
        try {
          const response = await fetch(`/api/dictionary?word=${encodeURIComponent(item.word)}`);
          return response.ok ? await response.json() as Word : item;
        } catch { return item; }
      }));
      setDetails(current => ({ ...current, ...Object.fromEntries(batch.map(item => [item.word, item])) }));
      done += batch.length; setStatus(`${done} / ${baseWords.length}語を取得中…`);
    }
    setLoading(false); setStatus(`${baseWords.length}語の意味と例文を取得しました。`);
  }

  function downloadCsv() {
    const rows = [['曲名', 'アーティスト', '単語', '品詞', '意味', '例文', '例文出典', '保存日時'], ...entries.flatMap(e => e.words.map(w => [e.song, e.artist, w.word, w.partOfSpeech ?? '', (w.meanings ?? [w.meaning ?? '']).filter(Boolean).join(' / '), w.example, w.exampleUrl ?? '', e.createdAt]))];
    const csv = rows.map(row => row.map(v => `"${v.replaceAll('"', '""')}"`).join(',')).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' }));
    a.download = 'lylicards.csv'; a.click(); URL.revokeObjectURL(a.href);
  }

  return <main className="min-h-screen bg-background text-foreground">
    <header className="border-b border-border/70 bg-card/80 backdrop-blur"><div className="mx-auto flex max-w-7xl items-center justify-between px-5 py-4">
      <div className="flex items-center gap-3"><span className="grid size-10 place-items-center rounded-xl bg-primary text-primary-foreground"><Music2 size={20}/></span><div><h1 className="text-lg font-bold tracking-tight">Lylicards</h1><p className="text-xs text-muted-foreground">歌からつくる、自分だけの単語帳</p></div></div><span className="rounded-full bg-accent px-3 py-1 text-xs font-medium text-accent-foreground">MVP</span>
    </div></header>
    <div className="mx-auto grid max-w-7xl gap-6 px-5 py-7 lg:grid-cols-[minmax(0,1fr)_360px]">
      <section className="space-y-6">
        <div className="panel"><div className="step"><span>1</span><div><h2>曲を探す</h2><p>Apple Musicの公開メタデータから検索します。</p></div></div>
          <form onSubmit={searchSongs} className="mt-5 flex gap-2"><Input aria-label="曲名またはアーティスト" value={query} onChange={e => setQuery(e.target.value)} placeholder="2文字以上で候補を表示" autoComplete="off" className="h-11"/><Button type="submit" className="h-11 gap-2"><Search size={17}/>検索</Button></form>
          {songs.length > 0 && <div className="mt-4"><p className="mb-2 text-xs font-semibold text-muted-foreground">候補</p><div className="grid gap-2 sm:grid-cols-2">{songs.map(song => <button key={song.trackId} onClick={() => selectSong(song)} className={`song ${selected?.trackId === song.trackId ? 'selected' : ''}`}><img src={song.artworkUrl100} alt=""/><span><strong>{song.trackName}</strong><small>{song.artistName}</small></span></button>)}</div></div>}
        </div>
        <div className="panel"><div className="step"><span>2</span><div><h2>歌詞を貼り付ける</h2><p>利用権のある歌詞だけを入力してください。歌詞本文は保存しません。</p></div></div>
          {selected && <><div className="mt-4 flex items-center gap-3 rounded-xl bg-accent/60 p-3"><img className="size-11 rounded-lg" src={selected.artworkUrl100} alt=""/><div className="min-w-0 flex-1"><strong className="block truncate">{selected.trackName}</strong><span className="text-sm text-muted-foreground">{selected.artistName}</span></div><a aria-label="曲のページを開く" href={selected.trackViewUrl} target="_blank" rel="noreferrer"><ExternalLink size={18}/></a></div><div className="mt-3"><a className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground" href={`https://genius.com/search?q=${encodeURIComponent(`${selected.trackName} ${selected.artistName}`)}`} target="_blank" rel="noreferrer">Geniusで歌詞を確認 <ExternalLink size={14}/></a></div><p className="mt-2 text-xs text-muted-foreground">Geniusで歌詞を確認し、個人学習の範囲で下欄へ貼り付けてください。</p></>}
          <Textarea value={lyrics} onChange={e => setLyrics(e.target.value)} className="mt-4 min-h-52 resize-y" placeholder="ここに英語の歌詞を貼り付け…"/><div className="mt-3 flex flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground"><span>{lyrics.length.toLocaleString()}文字・{baseWords.length}語</span><label className="flex items-center gap-2"><input type="checkbox" checked={excludeLearned} onChange={e => setExcludeLearned(e.target.checked)}/>学習済みの{learned.size}語を除外</label></div>
        </div>
      </section>
      <aside className="panel h-fit lg:sticky lg:top-6"><div className="step"><span>3</span><div><h2>単語帳にする</h2><p>全単語の意味と用例を取得します。</p></div></div>
        <Button variant="outline" onClick={fetchMeanings} disabled={!baseWords.length || loading} className="mt-5 h-11 w-full gap-2">{loading && <LoaderCircle className="animate-spin" size={16}/>}全{baseWords.length}語の意味・例文を取得</Button>
        <div className="mt-4 max-h-[52vh] min-h-44 space-y-2 overflow-y-auto pr-1">{words.length ? words.map(({word, meaning, meanings, partOfSpeech, example, exampleAuthor, exampleUrl}) => <div className="word" key={word}><div className="flex items-baseline gap-2"><strong>{word}</strong>{partOfSpeech && <small>{partOfSpeech}</small>}</div><ol className="meaning">{(meanings ?? [meaning ?? '']).filter(Boolean).map((item, index) => <li key={item}>{index + 1}. {item}</li>)}</ol><p>例: {example || '日常例文が見つかりませんでした'}</p>{exampleUrl && <a className="source" href={exampleUrl} target="_blank" rel="noreferrer">Tatoeba / {exampleAuthor || 'contributor'} · CC BY 2.0 FR</a>}</div>) : <div className="empty"><Sparkles size={26}/><p>歌詞を入力すると<br/>未学習の全単語が並びます</p></div>}</div>
        <Button onClick={save} disabled={!selected || !words.length || loading} className="mt-5 h-11 w-full">単語帳に保存</Button>{status && <p role="status" className="mt-3 text-sm text-muted-foreground">{status}</p>}
        <div className="mt-6 border-t pt-5"><div className="flex items-center justify-between"><span className="text-sm font-semibold">保存済み</span><span className="text-sm text-muted-foreground">{entries.reduce((n, e) => n + e.words.length, 0)}語</span></div><Button variant="outline" onClick={downloadCsv} disabled={!entries.length} className="mt-3 w-full gap-2"><Download size={16}/>CSVを書き出す</Button><p className="mt-2 text-xs leading-relaxed text-muted-foreground">CSVはGoogle Sheetsでそのまま読み込めます。データはこのブラウザ内だけに保存されます。</p></div>
      </aside>
    </div>
  </main>;
}
