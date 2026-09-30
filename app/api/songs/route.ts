type Song = {
  trackId: number;
  trackName: string;
  artistName: string;
  artworkUrl100: string;
  trackViewUrl: string;
};

type DeezerTrack = {
  id?: unknown;
  title?: unknown;
  link?: unknown;
  artist?: { name?: unknown };
  album?: { cover_medium?: unknown };
};

async function searchAppleMusic(query: string): Promise<Song[] | null> {
  try {
    const response = await fetch(
      `https://itunes.apple.com/search?media=music&entity=song&limit=6&term=${encodeURIComponent(query)}`,
      { headers: { accept: 'application/json' } },
    );
    if (!response.ok) return null;
    const data = await response.json() as { results?: Partial<Song>[] };
    if (!Array.isArray(data.results)) return null;
    return data.results
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
  } catch {
    return null;
  }
}

async function searchDeezer(query: string): Promise<Song[] | null> {
  try {
    const response = await fetch(
      `https://api.deezer.com/search?q=${encodeURIComponent(query)}&limit=6&lang=en`,
      { headers: { accept: 'application/json' } },
    );
    if (!response.ok) return null;
    const data = await response.json() as { data?: DeezerTrack[] };
    if (!Array.isArray(data.data)) return null;
    return data.data
      .filter((track): track is Required<Pick<DeezerTrack, 'id' | 'title' | 'link'>> & {
        artist: { name: string };
        album: { cover_medium: string };
      } =>
        typeof track.id === 'number'
        && typeof track.title === 'string'
        && typeof track.link === 'string'
        && typeof track.artist?.name === 'string'
        && typeof track.album?.cover_medium === 'string'
      )
      .map(track => ({
        trackId: track.id,
        trackName: track.title,
        artistName: track.artist.name,
        artworkUrl100: track.album.cover_medium,
        trackViewUrl: track.link,
      }));
  } catch {
    return null;
  }
}

export async function GET(request: Request) {
  const query = new URL(request.url).searchParams.get('q')?.trim();
  if (!query || query.length < 2) {
    return Response.json({ error: 'Search query must be at least two characters.' }, { status: 400 });
  }

  let results = await searchDeezer(query);
  if (!results?.length) {
    const fallbackResults = await searchAppleMusic(query);
    if (fallbackResults !== null) results = fallbackResults;
  }
  if (results === null) {
    return Response.json({ error: 'Song search is unavailable.' }, { status: 502 });
  }
  return Response.json(
    { results },
    { headers: { 'cache-control': 'public, max-age=60, s-maxage=300' } },
  );
}
