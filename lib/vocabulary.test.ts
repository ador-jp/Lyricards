import assert from 'node:assert/strict';
import test from 'node:test';
import { cleanLyrics, dailyFallback, extractWords, selectExample, selectMeanings } from './vocabulary.ts';

test('Genius headings and copied UI noise are removed', () => {
  assert.equal(cleanLyrics('[Chorus]\nYou know my name\n12Embed\nYou might also like'), 'You know my name');
});

test('multiple meanings are kept while bare surname entries are ignored', () => {
  assert.deepEqual(selectMeanings(['n\tSurname.', 'v\tTo understand.', 'n\tKnowledge.']).meanings, ['To understand.', 'Knowledge.']);
});

test('all unique words are returned without quoting lyrics and with exclusions', () => {
  const words = extractWords('Dream a little dream\nBright morning', new Set(['little']));
  assert.deepEqual(words.map(x => x.word), ['dream', 'bright', 'morning']);
  assert.equal(words[0].example, '');
});

test('daily examples prefer useful exact matches and always have a fallback', () => {
  const example = selectExample('must', [
    { id: 1, text: 'Warmongers must fuck off.' },
    { id: 2, text: 'Tom must take medicine.' },
    { id: 3, text: 'I must take medicine.' },
  ]);
  assert.equal(example?.text, 'I must take medicine.');
  assert.equal(dailyFallback('must', 'verb'), 'I must finish this before dinner.');
  assert.equal(dailyFallback('quiet', 'adjective'), 'That sounds quiet to me.');
});
