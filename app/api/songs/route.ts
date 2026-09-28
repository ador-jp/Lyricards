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

  const searchUrl = `https://itunes.apple.com/search?media=music&entity=song&limit=6&term=${encodeURIComponent(query)}`;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(searchUrl, {
        headers: { accept: 'application/json' },
      });
      if (response.ok) {
        const data = await response.json() as { results?: Partial<Song>[] };
        const results = (data.results ?? [])
          .filter((song): song is Song =>
            typeof song.trackId === 'number'
            && typeof song.trackName === 'string'
            && typeof song.artistName === 'string'
            && typeof song.artworkUrl100 === 'string'
            && typeof song.trackViewUrl === 'string'
          )
          .map(song => ({
            trackId: song.trackId,
            trackName: song.trackName,
            artistName: song.artistName,
            artworkUrl100: song.artworkUrl100,
            trackViewUrl: song.trackViewUrl,
          }));
        return Response.json(
          { results },
          { headers: { 'cache-control': 'public, max-age=60, s-maxage=300' } },
        );
      }
    } catch {
      // Retry transient upstream and JSON parsing failures.
    }
    if (attempt < 2) {
      await new Promise<void>(resolve => setTimeout(resolve, 250 * (attempt + 1)));
    }
  }
  return Response.json({ error: 'Song search is unavailable.' }, { status: 502 });
}
