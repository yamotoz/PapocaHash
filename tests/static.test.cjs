const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
const js = fs.readFileSync(path.join(__dirname, '../assets/app.js'), 'utf8');

test('HTML abre sem módulos ou serviços externos', () => {
  assert.doesNotMatch(html, /type="module"|https?:\/\/[^"\s]+\.(css|js)/);
  for (const match of html.matchAll(/(?:src|href)="(assets\/[^"#]+)"/g)) assert.ok(fs.existsSync(path.join(__dirname, '..', match[1])), match[1]);
});
test('Quatro algoritmos e controles essenciais acessíveis', () => {
  assert.equal((html.match(/class="algorithm-card /g) || []).length, 4);
  for (const id of ['server-status', 'prepare-form', 'engine-dialog', 'performance-chart', 'cancel-button', 'results-body']) assert.ok(html.includes(`id="${id}"`));
  const ids = [...html.matchAll(/id="([^"]+)"/g)].map(match => match[1]);
  assert.equal(new Set(ids).size, ids.length);
  for (const match of js.matchAll(/\$\('([^']+)'\)/g)) assert.ok(ids.includes(match[1]), `Elemento ausente: ${match[1]}`);
});
test('UI não insere resultados por HTML ou calcula hashes fictícios', () => {
  assert.doesNotMatch(js, /\.innerHTML\s*=|eval\(|Math\.random\(/);
  assert.match(js, /\/api/);
});
test('Logo e favicon são vetores próprios', () => {
  for (const file of ['logo.svg', 'favicon.svg']) assert.match(fs.readFileSync(path.join(__dirname, '../assets', file), 'utf8'), /<svg/);
});
