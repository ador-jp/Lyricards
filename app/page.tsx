'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Download, ExternalLink, LoaderCircle, Music2, Search, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { extractWords, type Word } from '@/lib/vocabulary';

type Song = { trackId: number; trackName: string; artistName: string; artworkUrl100: string; trackViewUrl: string };
type Entry = { id: string; song: string; artist: string; words: Word[]; createdAt: string };
const STORAGE_KEY = 'lyricards.entries';


export default function Home() {
  const [query, setQuery] = useState('');
  const [songs, setSongs] = useState<Song[]>([]);
  const [selected, setSelected] = useState<Song | null>(null);
  const [lyrics, setLyrics] = useState('');
  const [entries, setEntries] = useState<Entry[]>([]);
  const [entriesReady, setEntriesReady] = useState(false);
  const [status, setStatus] = useState('');
  const [searchStatus, setSearchStatus] = useState('');
  const [searching, setSearching] = useState(false);
  const [geniusUrl, setGeniusUrl] = useState('');
  const [geniusStatus, setGeniusStatus] = useState('');
  const [geniusLoading, setGeniusLoading] = useState(false);
  const [excludeLearned, setExcludeLearned] = useState(true);
  const [details, setDetails] = useState<Record<string, Partial<Word>>>({});
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const geniusRequest = useRef(0);
  const learned = useMemo(() => new Set(entries.flatMap(entry => entry.words.map(item => item.word.toLowerCase()))), [entries]);
  const baseWords = useMemo(() => extractWords(lyrics, excludeLearned ? learned : new Set()), [lyrics, excludeLearned, learned]);
  const words = useMemo(() => baseWords.map(item => ({ ...item, ...details[item.word], example: details[item.word]?.example || item.example })), [baseWords, details]);

  useEffect(() => {
    fetch('/api/entries').then(async response => {
      if (!response.ok) throw new Error();
      const data = await response.json() as { entries: Entry[] };
      setEntries(data.entries);
    }).catch(() => {
      try { setEntries(JSON.parse(localStorage.getItem(STORAGE_KEY) || localStorage.getItem('lylicards.entries') || localStorage.getItem('lyricbook.entries') || '[]')); } catch { /* empty */ }
      setStatus('保存データを読み込めませんでした。新しい保存は再試行できます。');
    }).finally(() => setEntriesReady(true));
  }, []);

  useEffect(() => {
    if (!entriesReady) return;
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(entries)); } catch { /* Local storage is optional. */ }
  }, [entries, entriesReady]);


  useEffect(() => {
    const context = (document as Document & { modelContext?: { registerTool: (tool: object, options: { signal: AbortSignal }) => void } }).modelContext;
    if (!context?.registerTool) return;
    const lifecycle = new AbortController();
    context.registerTool({
      name: 'save_vocabulary_entry', title: '単語帳を保存',
      description: '曲名、アーティスト、英語歌詞から頻出語の単語帳を保存します。',
      inputSchema: { type: 'object', properties: { song: { type: 'string' }, artist: { type: 'string' }, lyrics: { type: 'string' } }, required: ['song', 'artist', 'lyrics'], additionalProperties: false },
      annotations: { readOnlyHint: false, untrustedContentHint: true },
      async execute(input: unknown) {
        const value = input as { song?: string; artist?: string; lyrics?: string };
        if (!value.song?.trim() || !value.artist?.trim() || !value.lyrics?.trim()) throw new Error('song, artist, lyrics are required');
        const extracted = extractWords(value.lyrics);
        if (!extracted.length) throw new Error('No English words found');
        const entry = { id: crypto.randomUUID(), song: value.song, artist: value.artist, words: extracted, createdAt: new Date().toISOString() };
        const response = await fetch('/api/entries', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(entry) });
        if (!response.ok) throw new Error('保存できませんでした');
        setEntries(current => [entry, ...current]);
        return { saved: extracted.length, song: value.song };
      },
    }, { signal: lifecycle.signal });
    return () => lifecycle.abort();
  }, []);

  async function searchSongs(e: React.FormEvent) {
    e.preventDefault();
    const term = query.trim();
    if (term.length < 2) return setSearchStatus('2文字以上入力してください。');
    setSearching(true); setSearchStatus('検索中…');
    try {
      const response = await fetch(`/api/songs?q=${encodeURIComponent(term)}`);
      if (!response.ok) throw new Error();
      const payload = await response.json() as { results?: Song[] };
      if (!Array.isArray(payload.results)) throw new Error();
      setSongs(payload.results);
      setSearchStatus(payload.results.length ? '' : '候補が見つかりませんでした。');
    } catch {
      setSearchStatus('曲の検索サービスに接続できませんでした。少し待って再試行してください。');
    } finally {
      setSearching(false);
    }
  }

  async function save() {
    if (!selected) return setStatus('先に曲を選んでください。');
    if (!lyrics.trim()) return setStatus('英語の歌詞を貼り付けてください。');
    if (!words.length) return setStatus(extractWords(lyrics).length ? 'この歌詞の単語はすべて保存済みです。下のCSVから確認できます。' : '保存できる英単語が見つかりませんでした。');
    const savedWordCount = words.length;
    const entry = { id: crypto.randomUUID(), song: selected.trackName, artist: selected.artistName, words, createdAt: new Date().toISOString() };
    setSaving(true); setStatus('保存中…');
    let savedRemotely = false;
    try {
      const response = await fetch('/api/entries', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(entry) });
      savedRemotely = response.ok;
    } catch {
      // Keep the entry in this browser when the server is unavailable.
    }
    setEntries(current => [entry, ...current]);
    setQuery(''); setSongs([]); setSearchStatus('');
    geniusRequest.current += 1;
    setSelected(null); setLyrics(''); setDetails({});
    setGeniusUrl(''); setGeniusStatus(''); setGeniusLoading(false);
    setStatus(savedRemotely
      ? `${savedWordCount}語を保存しました。続けて次の曲を検索できます。`
      : '通信できなかったため、この端末に一時保存しました。続けて次の曲を検索できます。');
    setSaving(false);
  }

  async function selectSong(song: Song) {
    const requestId = ++geniusRequest.current;
    setSelected(song); setLyrics(''); setDetails({});
    setGeniusUrl(''); setGeniusStatus(''); setGeniusLoading(true);
    setStatus('曲を選択しました。Geniusの歌詞ページを確認して、歌詞を下欄へ貼り付けてください。');
    try {
      const response = await fetch(`/api/genius?song=${encodeURIComponent(song.trackName)}&artist=${encodeURIComponent(song.artistName)}`);
      if (!response.ok) throw new Error();
      const payload = await response.json() as { url?: string };
      if (typeof payload.url !== 'string' || new URL(payload.url).origin !== 'https://genius.com') throw new Error();
      if (geniusRequest.current === requestId) setGeniusUrl(payload.url);
    } catch {
      if (geniusRequest.current === requestId) setGeniusStatus('Geniusの歌詞ページが見つかりませんでした。別の候補を選ぶか、曲名を確認してください。');
    } finally {
      if (geniusRequest.current === requestId) setGeniusLoading(false);
    }
  }

  async function fetchMeanings() {
    if (!baseWords.length) return;
    setLoading(true); setStatus(`0 / ${baseWords.length}語を取得中…`);
    const lookup = async (item: Word): Promise<{ result: Word; resolved: boolean }> => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15_000);
        try {
          const response = await fetch(`/api/dictionary?word=${encodeURIComponent(item.word)}`, { signal: controller.signal });
          if (response.ok) {
            const result = await response.json() as Word;
            const hasMeaning = Boolean(result.meaning || result.meanings?.length);
            return { result, resolved: hasMeaning && Boolean(result.partOfSpeech) };
          }
        } catch {
          // Retry transient API and network failures.
        } finally {
          clearTimeout(timeout);
        }
        if (attempt < 2) await new Promise<void>(resolve => setTimeout(resolve, 250 * (attempt + 1)));
      }
      return { result: item, resolved: false };
    };
    const runBatch = async (items: Word[], retrying: boolean) => {
      let cursor = 0; let done = 0;
      const unresolved: Word[] = [];
      const worker = async () => {
        while (cursor < items.length) {
          const item = items[cursor++];
          const { result, resolved } = await lookup(item);
          setDetails(current => {
            const hasData = Boolean(result.partOfSpeech || result.meaning || result.meanings?.length || result.example);
            return { ...current, [item.word]: hasData ? result : current[item.word] ?? result };
          });
          if (!resolved) unresolved.push(item);
          done += 1;
          setStatus(`${done} / ${items.length}語を${retrying ? '再取得' : '取得'}中…`);
        }
      };
      await Promise.all(Array.from({ length: Math.min(4, items.length) }, worker));
      return unresolved;
    };
    try {
      let unresolved = await runBatch(baseWords, false);
      const automaticRetryCount = unresolved.length;
      if (automaticRetryCount) {
        setStatus(`${automaticRetryCount}語を自動で再取得中…`);
        await new Promise<void>(resolve => setTimeout(resolve, 750));
        unresolved = await runBatch(unresolved, true);
      }
      setStatus(unresolved.length
        ? `${baseWords.length - unresolved.length}語を取得、${unresolved.length}語は自動再取得後も品詞・意味を取得できませんでした。再試行できます。`
        : automaticRetryCount
          ? `${baseWords.length}語の意味と例文を取得しました。未取得だった${automaticRetryCount}語は自動で再取得しました。`
          : `${baseWords.length}語の意味と例文を取得しました。`);
    } finally { setLoading(false); }
  }

  function downloadCsv() {
    const savedRows = entries.flatMap(e => e.words.map(w => [e.song, e.artist, w.word, w.partOfSpeech ?? '', (w.meanings ?? [w.meaning ?? '']).filter(Boolean).join(' / '), w.example, w.exampleUrl ?? '', e.createdAt]));
    const draftRows = selected ? words.map(w => [selected.trackName, selected.artistName, w.word, w.partOfSpeech ?? '', (w.meanings ?? [w.meaning ?? '']).filter(Boolean).join(' / '), w.example, w.exampleUrl ?? '', new Date().toISOString()]) : [];
    const rows = [['曲名', 'アーティスト', '単語', '品詞', '意味', '例文', '例文出典', '保存日時'], ...savedRows, ...draftRows];
    const csv = rows.map(row => row.map(v => `"${v.replace(/"/g, '""')}"`).join(',')).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' }));
    a.download = 'lyricards.csv'; document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  return <main className="min-h-screen bg-background text-foreground">
    <header className="border-b border-border/70 bg-card/80 backdrop-blur"><div className="mx-auto flex max-w-7xl items-center justify-between px-3 py-3 sm:px-5 sm:py-4">
      <div className="flex items-center gap-3"><span className="grid size-10 place-items-center rounded-xl bg-primary text-primary-foreground"><Music2 size={20}/></span><div><h1 className="text-lg font-bold tracking-tight">Lyricards</h1><p className="text-xs text-muted-foreground">歌からつくる、自分だけの単語帳</p></div></div><span className="rounded-full bg-accent px-3 py-1 text-xs font-medium text-accent-foreground">MVP</span>
    </div></header>
    <div className="mx-auto grid max-w-7xl gap-4 px-3 py-4 sm:gap-6 sm:px-5 sm:py-7 lg:grid-cols-[minmax(0,1fr)_360px]">
      <section className="space-y-6">
        <div className="panel"><div className="step"><span>1</span><div><h2>曲を探す</h2><p>曲名またはアーティスト名を入力して検索します。</p></div></div>
          <form onSubmit={searchSongs} className="mt-5 grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]"><Input aria-label="曲名またはアーティスト" value={query} onChange={e => { setQuery(e.target.value); setSongs([]); setSearchStatus(''); }} placeholder="曲名またはアーティスト名" autoComplete="off" enterKeyHint="search" className="h-11"/><Button type="submit" disabled={searching} className="h-11 w-full gap-2 sm:w-auto">{searching ? <LoaderCircle className="animate-spin" size={16}/> : <Search size={17}/>} {searching ? '検索中…' : '検索'}</Button></form>{searchStatus && <p role="status" className="mt-2 text-sm text-muted-foreground">{searchStatus}</p>}
          {songs.length > 0 && <div className="mt-4"><p className="mb-2 text-xs font-semibold text-muted-foreground">候補</p><div className="grid gap-2 sm:grid-cols-2">{songs.map(song => <button type="button" key={song.trackId} onClick={() => void selectSong(song)} className={`song w-full touch-manipulation ${selected?.trackId === song.trackId ? 'selected' : ''}`}><img src={song.artworkUrl100} alt=""/><span><strong>{song.trackName}</strong><small>{song.artistName}</small></span></button>)}</div></div>}
        </div>
        <div className="panel"><div className="step"><span>2</span><div><h2>歌詞を貼り付ける</h2><p>利用権のある歌詞だけを入力してください。歌詞本文は保存しません。</p></div></div>
          {selected && <><div className="mt-4 flex items-center gap-3 rounded-xl bg-accent/60 p-3"><img className="size-11 rounded-lg" src={selected.artworkUrl100} alt=""/><div className="min-w-0 flex-1"><strong className="block truncate">{selected.trackName}</strong><span className="text-sm text-muted-foreground">{selected.artistName}</span></div><a aria-label="曲のページを開く" href={selected.trackViewUrl} target="_blank" rel="noreferrer"><ExternalLink size={18}/></a></div><div className="mt-3">{geniusUrl ? <a className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground" href={geniusUrl} target="_blank" rel="noreferrer">Geniusで歌詞ページを開く <ExternalLink size={14}/></a> : <Button type="button" disabled className="gap-2">{geniusLoading && <LoaderCircle className="animate-spin" size={16}/>} {geniusLoading ? 'Geniusの歌詞を検索中…' : 'Geniusの歌詞ページなし'}</Button>}</div>{geniusStatus && <p role="status" className="mt-2 text-xs text-muted-foreground">{geniusStatus}</p>}<p className="mt-2 text-xs text-muted-foreground">Geniusの歌詞ページを確認し、個人学習の範囲で下欄へ貼り付けてください。</p></>}
          <Textarea value={lyrics} onChange={e => setLyrics(e.target.value)} className="mt-4 min-h-52 resize-y" placeholder="ここに英語の歌詞を貼り付け…"/><div className="mt-3 flex flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground"><span>{lyrics.length.toLocaleString()}文字・{baseWords.length}語</span><label className="flex min-h-11 touch-manipulation items-center gap-2"><input className="size-5" type="checkbox" checked={excludeLearned} onChange={e => setExcludeLearned(e.target.checked)}/>学習済みの{learned.size}語を除外</label></div>
        </div>
      </section>
      <aside className="panel h-fit lg:sticky lg:top-6"><div className="step"><span>3</span><div><h2>単語帳にする</h2><p>全単語の意味と用例を取得します。</p></div></div>
        <Button variant="outline" onClick={fetchMeanings} disabled={!baseWords.length || loading} className="mt-5 h-11 w-full gap-2">{loading && <LoaderCircle className="animate-spin" size={16}/>}全{baseWords.length}語の意味・例文を取得</Button>
        <div className="mt-4 min-h-44 space-y-2 lg:max-h-[52vh] lg:overflow-y-auto lg:pr-1">{words.length ? words.map(({word, meaning, meanings, partOfSpeech, example, exampleAuthor, exampleUrl}) => <div className="word" key={word}><div className="flex items-baseline gap-2"><strong>{word}</strong>{partOfSpeech && <small>{partOfSpeech}</small>}</div><ol className="meaning">{(meanings ?? [meaning ?? '']).filter(Boolean).map((item, index) => <li key={item}>{index + 1}. {item}</li>)}</ol><p>例: {example || '日常例文が見つかりませんでした'}</p>{exampleUrl && <a className="source" href={exampleUrl} target="_blank" rel="noreferrer">Tatoeba / {exampleAuthor || 'contributor'} · CC BY 2.0 FR</a>}</div>) : <div className="empty"><Sparkles size={26}/><p>歌詞を入力すると<br/>未学習の全単語が並びます</p></div>}</div>
        <Button onClick={save} disabled={saving || loading} className="mt-5 h-11 w-full">{saving ? '保存中…' : '単語帳に保存'}</Button>{status && <p role="status" className="mt-3 text-sm text-muted-foreground">{status}</p>}
        <div className="mt-6 border-t pt-5"><div className="flex items-center justify-between"><span className="text-sm font-semibold">保存済み</span><span className="text-sm text-muted-foreground">{entries.reduce((n, e) => n + e.words.length, 0)}語</span></div>{entries.slice(0, 3).map(entry => <p key={entry.id} className="mt-2 truncate text-xs text-muted-foreground">✓ {entry.song} — {entry.artist}（{entry.words.length}語）</p>)}<Button variant="outline" onClick={downloadCsv} disabled={!entries.length && !words.length} className="mt-3 w-full gap-2"><Download size={16}/>CSVを書き出す</Button><p className="mt-2 text-xs leading-relaxed text-muted-foreground">未保存の解析結果もCSVに含めます。Google Sheetsでそのまま読み込めます。</p></div>
      </aside>
    </div>
  </main>;
}
