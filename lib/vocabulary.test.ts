import assert from 'node:assert/strict';
import test from 'node:test';
import { cleanImportedLyrics, extractWords } from './vocabulary.ts';

test('frequent content words come first and lyrics are not retained', () => {
  assert.deepEqual(extractWords('Dream a little dream, bright dream!').map(x => x.word), ['dream', 'bright', 'little']);
});

test('LRC timestamps and metadata are removed on import', () => {
  assert.equal(cleanImportedLyrics('[ar:Artist]\n[00:12.30]Hello world'), 'Hello world');
});
