export type Word = { word: string; example: string };

const STOP = new Set('a an and are as at be been but by can did do for from had has have he her him his i if in into is it its me my no not of on or our out she so than that the their them there they this to up was we were what when where which who will with would you your'.split(' '));

export function extractWords(text: string): Word[] {
  const counts = new Map<string, number>();
  for (const raw of text.toLowerCase().match(/[a-z]+(?:'[a-z]+)?/g) ?? []) {
    if (raw.length > 2 && !STOP.has(raw)) counts.set(raw, (counts.get(raw) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 12)
    .map(([word]) => ({ word, example: `I learned how to use “${word}” from this song.` }));
}

export function cleanImportedLyrics(text: string): string {
  return text.replace(/^\[(?:\d{1,2}:\d{2}(?:\.\d{1,3})?|ar:|ti:|al:|by:|offset:).*?\]\s*/gim, '').trim();
}
