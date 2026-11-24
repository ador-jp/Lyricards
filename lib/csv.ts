const FORMULA_PREFIX = /^(?:[\t\r]|\s*[=+\-@＝＋－＠])/;

export function csvCell(value: string) {
  const safe = FORMULA_PREFIX.test(value) ? `'${value}` : value;
  return `"${safe.replace(/"/g, '""')}"`;
}

export function toCsv(rows: string[][]) {
  return rows.map(row => row.map(csvCell).join(',')).join('\n');
}
