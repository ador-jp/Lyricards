import assert from 'node:assert/strict';
import test from 'node:test';
import { cleanLyrics, extractWords, selectMeanings } from './vocabulary.ts';

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
