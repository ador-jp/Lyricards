import assert from 'node:assert/strict';
import test from 'node:test';
import { cleanLyrics, dailyFallback, extractWords, selectExample, selectMeanings } from './vocabulary.ts';

void test('Genius headings and copied UI noise are removed', () => {
  assert.equal(cleanLyrics('[Chorus]\nYou know my name\n12Embed\nYou might also like'), 'You know my name');
});

void test('multiple meanings are kept while bare surname entries are ignored', () => {
  assert.deepEqual(selectMeanings(['n\tSurname.', 'v\tTo understand.', 'n\tKnowledge.']).meanings, ['To understand.', 'Knowledge.']);
});

void test('all unique words are returned without quoting lyrics and with exclusions', () => {
  const words = extractWords('Dream a little dream\nBright morning', new Set(['little']));
  assert.deepEqual(words.map(x => x.word), ['dream', 'bright', 'morning']);
  assert.equal(words[0].example, '');
});

void test('curly apostrophes keep contractions whole instead of splitting off fragments', () => {
  const words = extractWords('I don\u2019t know why you\u2019re gone\nWe won\u2019t stop, it isn\u02bct over \u2018cause');
  assert.deepEqual(words.map(x => x.word).sort(), ["cause", "don't", 'gone', "isn't", 'know', 'over', 'stop', 'why', "won't", "you're"]);
});

void test('accented letters are folded so words are not split into fragments', () => {
  const words = extractWords('Beyonc\u00e9 sang a clich\u00e9 in the caf\u00e9\nSe\u00f1orita, so na\u00efve, de\u0301ja\u0300 vu');
  assert.deepEqual(words.map(x => x.word).sort(), ['beyonce', 'cafe', 'cliche', 'deja', 'naive', 'sang', 'senorita']);
});

void test('daily examples prefer useful exact matches and always have a fallback', () => {
  const example = selectExample('must', [
    { id: 1, text: 'Warmongers must fuck off.' },
    { id: 2, text: 'Tom must take medicine.' },
    { id: 3, text: 'I must take medicine.' },
  ]);
  assert.equal(example?.text, 'I must take medicine.');
  assert.equal(dailyFallback('must', 'verb'), 'I must finish this before dinner.');
  assert.equal(dailyFallback('quiet', 'adjective'), 'That sounds quiet to me.');
});
