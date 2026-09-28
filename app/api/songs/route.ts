type Song = {
  trackId: number;
  trackName: string;
  artistName: string;
  artworkUrl100: string;
  trackViewUrl: string;
};

export async function GET(request: Request) {
  const query = new URL(request.url).searchParams.get('q')?.trim();
  if (!query || query.length < 2) {
    return Response.json({ error: 'Search query must be at least two characters.' }, { status: 400 });
  }

  try {
    const response = await fetch(
      `https://itunes.apple.com/search?media=music&entity=song&limit=6&term=${encodeURIComponent(query)}`,
      { headers: { accept: 'application/json' } },
    );
    if (!response.ok) throw new Error('Apple Music search failed');

    const data = await response.json() as { results?: Partial<Song>[] };
    const results = (data.results ?? []).filter((song): song is Song =>
      typeof song.trackId === 'number'
      && typeof song.trackName === 'string'
      && typeof song.artistName === 'string'
      && typeof song.artworkUrl100 === 'string'
      && typeof song.trackViewUrl === 'string'
    );
    return Response.json({ results });
  } catch {
    return Response.json({ error: 'Song search is unavailable.' }, { status: 502 });
  }
}
