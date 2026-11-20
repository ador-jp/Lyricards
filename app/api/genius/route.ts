import { fetchUpstream } from '../../../lib/upstream.ts';

type GeniusResult = {
  title?: unknown;
  artist_names?: unknown;
  url?: unknown;
  lyrics_state?: unknown;
};

type GeniusSection = {
  type?: unknown;
  hits?: Array<{ type?: unknown; result?: GeniusResult }>;
};

function normalize(value: string) {
  return value
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function cleanSongTitle(title: string) {
  return title
    .replace(/\s+[([](?:feat\.?|ft\.?|featuring|with)\s[^)\]]*[)\]]/gi, '')
    .replace(/\s+-\s+[^-]*(?:remaster(?:ed)?|version|mix|edit|live|acoustic|mono|stereo)[^-]*$/i, '')
    .replace(/\s*[([][^)\]]*(?:remaster(?:ed)?|version|mix|edit|live|acoustic|mono|stereo)[^)\]]*[)\]]\s*$/i, '')
    .trim();
}

async function searchGenius(query: string) {
  try {
    const response = await fetchUpstream(`https://genius.com/api/search/multi?q=${encodeURIComponent(query)}`);
    if (!response.ok) return null;
    const data = await response.json() as { response?: { sections?: GeniusSection[] } };
    if (!Array.isArray(data.response?.sections)) return null;
    return data.response.sections
      .filter(section => section.type === 'top_hit' || section.type === 'song')
      .flatMap(section => Array.isArray(section.hits) ? section.hits : [])
      .filter(hit => hit.type === 'song')
      .map(hit => hit.result)
      .filter((result): result is GeniusResult & { title: string; artist_names: string; url: string } =>
        result !== undefined
        && typeof result.title === 'string'
        && typeof result.artist_names === 'string'
        && typeof result.url === 'string'
        && result.url.startsWith('https://genius.com/')
      );
  } catch {
    return null;
  }
}

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const song = cleanSongTitle(params.get('song')?.trim() ?? '');
  const artist = params.get('artist')?.trim() ?? '';
  if (!song) return Response.json({ error: 'Song is required.' }, { status: 400 });

  const expectedTitle = normalize(song);
  const expectedArtist = normalize(artist);
  const cacheControl = 'public, max-age=3600, s-maxage=86400';
  const combinedResults = artist ? await searchGenius(`${song} ${artist}`) : [];
  const artistMatch = combinedResults?.find(result => {
    const resultArtist = normalize(result.artist_names);
    return normalize(result.title) === expectedTitle
      && (resultArtist.includes(expectedArtist) || expectedArtist.includes(resultArtist));
  });
  if (artistMatch) {
    return Response.json({ url: artistMatch.url }, { headers: { 'cache-control': cacheControl } });
  }

  const titleResults = await searchGenius(song);
  const titleMatch = titleResults?.find(result => normalize(result.title) === expectedTitle)
    ?? titleResults?.find(result => normalize(result.title).startsWith(`${expectedTitle} `));
  if (titleMatch) {
    return Response.json(
      { url: titleMatch.url },
      { headers: { 'cache-control': combinedResults === null ? 'no-store' : cacheControl } },
    );
  }
  if (combinedResults === null || titleResults === null) {
    return Response.json(
      { error: 'Genius search is unavailable.' },
      { status: 502, headers: { 'cache-control': 'no-store' } },
    );
  }

  return Response.json({ error: 'No Genius lyrics page was found.' }, { status: 404 });
}
