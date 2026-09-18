import assert from 'node:assert/strict';
import test from 'node:test';
import { extractWords } from './vocabulary.ts';

test('frequent content words come first and lyrics are not retained', () => {
  assert.deepEqual(extractWords('Dream a little dream, bright dream!').map(x => x.word), ['dream', 'bright', 'little']);
});
