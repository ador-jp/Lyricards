import assert from 'node:assert/strict';
import test from 'node:test';
import { csvCell, toCsv } from './csv.ts';

void test('cells that spreadsheets would evaluate as formulas are neutralized', () => {
  for (const value of ['=HYPERLINK("https://evil.test","x")', '+1+1', '-2+3', '@SUM(A1)', '\t=1', '\r=1', '\t', ' =1', '  +1', '\n=1', '\r\n@SUM(A1)', '\u3000=1', '＝1', '＋1', '－1', '＠SUM(A1)', ' ＝1']) {
    assert.equal(csvCell(value), `"'${value.replace(/"/g, '""')}"`);
  }
});

void test('ordinary cells are quoted with escaped double quotes and left otherwise unchanged', () => {
  assert.equal(csvCell('Say "hi" = hello'), '"Say ""hi"" = hello"');
  assert.equal(csvCell(''), '""');
  assert.equal(csvCell(' leading space'), '" leading space"');
  assert.equal(csvCell('a=b'), '"a=b"');
  assert.equal(csvCell('line one\nline two'), '"line one\nline two"');
  assert.equal(toCsv([['曲名', 'アーティスト'], ['=cmd', 'Artist']]), '"曲名","アーティスト"\n"\'=cmd","Artist"');
});
