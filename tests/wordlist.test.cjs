const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('Wordlist física: um milhão de entradas distintas e índice interoperável', () => {
  const root = path.join(__dirname, '../data/base');
  const text = fs.readFileSync(path.join(root, 'wordlist1kk.txt'));
  const offsets = fs.readFileSync(path.join(root, 'offsets.bin'));
  const words = text.toString('ascii').trimEnd().split('\n');
  assert.equal(words.length, 1_000_000);
  assert.equal(new Set(words).size, 1_000_000);
  assert.equal(offsets.length, 8_000_008);
  for (const i of [0, 1, 499_999, 500_000, 999_999]) {
    const start = Number(offsets.readBigUInt64LE(i * 8));
    const end = Number(offsets.readBigUInt64LE((i + 1) * 8));
    assert.equal(text.subarray(start, end).toString(), words[i] + '\n');
  }
  assert.equal(Number(offsets.readBigUInt64LE(1_000_000 * 8)), text.length);
});
