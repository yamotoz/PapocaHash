/* Contratos de UI usam fixtures explícitas; não substituem testes dos motores. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}) });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'no-preference' });
  await page.addInitScript(() => {
    window.chartFrames = [];
    const context = CanvasRenderingContext2D.prototype;
    const clear = context.clearRect, arc = context.arc;
    context.clearRect = function (...args) {
      if (this.canvas.id === 'performance-chart') { window.chartFrames.push({ endpoints: [] }); window.chartFrames = window.chartFrames.slice(-120); }
      return clear.apply(this, args);
    };
    context.arc = function (...args) {
      if (this.canvas.id === 'performance-chart' && args[2] === 3) window.chartFrames.at(-1)?.endpoints.push({ x: args[0], y: args[1] });
      return arc.apply(this, args);
    };
  });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  let online = true, sequence = 0, mode = 'found', livePolls = 0;
  const jobs = new Map();
  const engines = [
    { id: 'python-iterative', name: 'Python iterativo', strategy: 'Iterativo · multiprocessos', lines: 5, available: true },
    { id: 'python-recursive', name: 'Python recursivo', strategy: 'Recursivo · multiprocessos', lines: 9, available: true },
    { id: 'rust', name: 'Rust paralelo', strategy: 'Múltiplas threads', lines: 24, available: true }
  ];
  await page.route('http://127.0.0.1:8765/api/**', async route => {
    const request = route.request(), url = new URL(request.url());
    const headers = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-allow-headers': 'content-type' };
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    if (!online) return route.abort();
    let body;
    if (url.pathname === '/api/health') body = { service: 'PapocaHash', workers: 16, engines, gpu: { available: true, name: 'NVIDIA GeForce RTX 5050 Laptop GPU', usage: 7 }, gpu_engine: { available: true, devices: [{ id: 1, name: 'NVIDIA GeForce RTX 5050 Laptop GPU' }], backend: 'OpenCL' } };
    else if (url.pathname === '/api/experiments') body = { id: 'fixture', count: 1_000_000, position: 750_000, targets: { md5: '900150983cd24fb0d6963f7d28e17f72', sha512: 'a'.repeat(128), bcrypt: '$2b$04$fixture', argon2id: '$argon2id$fixture' } };
    else if (url.pathname === '/api/jobs' && request.method() === 'POST') { const data = request.postDataJSON(); const job = { ...data, id: String(++sequence), count: 1_000_000, status: 'queued', attempts: 0, elapsed: 0, samples: [{ attempts: 0, elapsed: 0 }] }; jobs.set(job.id, job); body = job; }
    else if (url.pathname.endsWith('/cancel')) { jobs.get(url.pathname.split('/')[3]).status = 'cancelled'; body = { requested: true }; }
    else {
      const job = jobs.get(url.pathname.split('/').at(-1));
      const attempts = mode === 'running' ? Math.min(700_000, ++livePolls * 20_000) : 752_112;
      const elapsed = mode === 'running' ? livePolls * .137 : .45 + Number(job.id) * .1;
      const previews = job.device === 'gpu' ? [] : Array.from({ length: 16 }, (_, index) => {
        const word = `papoca${String(attempts + index - 1).padStart(7, '0')}`;
        return { seq: livePolls * 16 + index + 1, worker: index + 1, position: attempts + index, word,
          hash: job.algorithm === 'md5' ? createHash('md5').update(word).digest('hex') : `hash-da-amostra-${index}` };
      });
      Object.assign(job, { status: job.status === 'cancelled' ? 'cancelled' : mode, word: 'abc', position: 750_000, attempts, elapsed, rate: 1_000_000, cpu: 95, cpu_average: 91, cpu_peak: 98, memory_mb: 180, memory_peak_mb: 190, setup_seconds: .12, total_seconds: .8, preview_candidates: previews, samples: [{ attempts: 0, elapsed: 0 }, { attempts: attempts / 2, elapsed: elapsed / 2 }, { attempts, elapsed }] }); body = job;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', headers, body: JSON.stringify(body) });
  });
  async function checkTooltip(icon, label) {
    await icon.hover();
    await page.locator('#info-tooltip').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#info-tooltip').textContent(), await icon.getAttribute('data-tip'), label);
    const geometry = await page.locator('#info-tooltip').evaluate(bubble => {
      const rect = bubble.getBoundingClientRect();
      return {
        fits: rect.left >= 11 && rect.top >= 11 && rect.right <= innerWidth - 11 && rect.bottom <= innerHeight - 11,
        readable: bubble.scrollWidth <= bubble.clientWidth,
        onTop: bubble.contains(document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2))
      };
    });
    assert.deepEqual(geometry, { fits: true, readable: true, onTop: true }, `${label}: ${await icon.getAttribute('aria-label')}`);
    await page.mouse.move(0, 0);
  }
  async function checkLayoutsAndTooltips() {
    for (const [width, height] of [[1440, 1000], [1024, 768], [768, 600], [390, 844], [320, 568], [844, 390]]) {
      await page.setViewportSize({ width, height });
      const icons = page.locator('.info:visible');
      for (let i = 0; i < await icons.count(); i++) await checkTooltip(icons.nth(i), `Tooltip da página ${i}, ${width}x${height}`);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `Página ${width}x${height}`);
      for (const algorithm of ['md5', 'sha512', 'bcrypt', 'argon2id']) {
        await page.locator(`[data-algorithm="${algorithm}"]`).click();
        assert.equal(await page.locator('#engine-dialog').evaluate(dialog => dialog.scrollWidth <= dialog.clientWidth), true, `Dialog ${algorithm}, ${width}x${height}`);
        const overlap = await page.locator('#engine-options').evaluate(container => [...container.children].some(label => {
          const subtitle = label.querySelector('small').getBoundingClientRect();
          const tags = label.querySelector('.engine-tags').getBoundingClientRect();
          return subtitle.bottom > tags.top + 1;
        }));
        assert.equal(overlap, false, `Tags dos motores ${algorithm}, ${width}x${height}`);
        const dialogIcons = page.locator('#engine-dialog .info:visible');
        for (let i = 0; i < await dialogIcons.count(); i++) await checkTooltip(dialogIcons.nth(i), `Tooltip ${algorithm}/${i}, ${width}x${height}`);
        const icon = dialogIcons.last();
        await icon.focus();
        await page.locator('#info-tooltip').waitFor({ state: 'visible' });
        await page.keyboard.press('Escape');
        assert.equal(await page.locator('#info-tooltip').isVisible(), false);
        assert.equal(await page.locator('#engine-dialog').evaluate(dialog => dialog.open), true);
        const selected = await page.locator('input[name="engine"]:checked').inputValue();
        await page.locator('#engine-options .info').last().click();
        assert.equal(await page.locator('input[name="engine"]:checked').inputValue(), selected, 'Tocar no i preserva o motor selecionado');
        if (algorithm === 'argon2id' && [1440, 390].includes(width)) {
          fs.mkdirSync(path.join(__dirname, '../test-results'), { recursive: true });
          await page.screenshot({ path: path.join(__dirname, `../test-results/dialog-${width}.png`) });
        }
        await page.locator('.dialog-close').click();
        await page.locator('#info-tooltip').waitFor({ state: 'hidden' });
      }
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
  }
  try {
    await page.goto(pathToFileURL(path.join(__dirname, '../index.html')).href);
    await page.waitForFunction(() => document.getElementById('status-text').textContent === 'Servidor online');
    assert.deepEqual(await page.locator('.card-complexity').allTextContents(), [
      'BIG O · O(n × L)', 'BIG O · O(n × L)', 'BIG O · O(n × 2^c)', 'BIG O · O(n × m × t)'
    ]);
    assert.equal(await page.locator('.card-art').first().evaluate(element => element.getAnimations().length > 0), true);
    assert.equal(await page.locator('.code-tags > span').first().evaluate(element => parseFloat(getComputedStyle(element).fontSize) >= 11), true);
    assert.equal(await page.locator('.code-card .big-o-tag').count(), 3);
    const pythonSource = fs.readFileSync(path.join(__dirname, '../backend/kernels.py'), 'utf8').replace(/\r\n/g, '\n');
    for (const name of ['iterative', 'recursive']) {
      const start = pythonSource.indexOf(`def ${name}(`), next = pythonSource.indexOf('\ndef ', start + 1);
      assert.equal((await page.locator(`#kernel-${name}`).textContent()).trim(), pythonSource.slice(start, next < 0 ? undefined : next).trim(), 'A vitrine mostra o núcleo real');
    }
    const rustCore = fs.readFileSync(path.join(__dirname, '../rust-engine/src/kernel.rs'), 'utf8').split('#[cfg(test)]')[0].trim();
    assert.equal((await page.locator('#kernel-rust').textContent()).trim(), rustCore, 'A vitrine mostra o núcleo Rust real');
    await page.locator('#master-word').fill('abc');
    await page.locator('#prepare-button').click();
    await page.locator('#prepared-result').waitFor({ state: 'visible' });
    assert.match(await page.locator('#insertion-text').textContent(), /750\.000/);
    await checkLayoutsAndTooltips();
    await page.locator('[data-algorithm="md5"]').click();
    assert.equal(await page.locator('#worker-count').inputValue(), '16');
    await page.locator('#worker-count').fill('17');
    await page.locator('#run-button').click();
    assert.match(await page.locator('#dialog-message').textContent(), /Confira/);
    assert.equal(jobs.size, 0);
    await page.locator('#worker-count').fill('16');
    mode = 'running';
    await page.locator('#rank-button').click();
    await page.waitForFunction(() => document.querySelectorAll('#rank-stream-slot .stream-log-row').length >= 4);
    const rankSamples = await page.locator('#stream-log .stream-log-row:not(.found)').evaluateAll(rows => rows.map(row => ({
      word: row.querySelector('.stream-log-word').textContent,
      hash: row.querySelector('.stream-log-hash').textContent
    })));
    assert.ok(rankSamples.every(sample => sample.hash === createHash('md5').update(sample.word).digest('hex')), 'O ranking mostra hashes reais para cada palavra');
    mode = 'found';
    await page.waitForFunction(() => document.getElementById('rank-phase').textContent === 'AGUARDANDO PRÓXIMO');
    assert.equal(jobs.size, 1, 'Só o primeiro motor é enviado ao iniciar o ranking');
    assert.equal(await page.locator('#rank-steps .rank-step[data-state="done"]').count(), 1);
    await page.locator('#rank-next').click();
    await page.waitForFunction(() => document.getElementById('rank-progress').textContent.includes('2 / 3') && document.getElementById('rank-phase').textContent === 'AGUARDANDO PRÓXIMO');
    assert.equal(jobs.size, 2, 'O segundo motor só começa após Próximo');
    await page.locator('#rank-next').click();
    await page.waitForFunction(() => document.getElementById('rank-phase').textContent === 'RANKING CONCLUÍDO');
    assert.equal(jobs.size, 3, 'O terceiro motor só começa após o segundo Próximo');
    assert.equal(await page.locator('#rank-next').isHidden(), true);
    assert.match(await page.locator('#rank-summary').textContent(), /Mais rápido/);
    assert.equal(await page.locator('#rank-steps .rank-step-place').count(), 3);
    await page.locator('#result-banner').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#results-body tr').count(), 3);
    assert.match(await page.locator('#result-banner').textContent(), /abc/);
    assert.equal(await page.locator('#stream-word').textContent(), 'abc');
    assert.equal(await page.locator('#stream-hash').getAttribute('title'), '900150983cd24fb0d6963f7d28e17f72');
    assert.equal(await page.locator('#stream-status').textContent(), 'PALAVRA ENCONTRADA');
    assert.equal(await page.locator('#candidate-stream').evaluate(element => !!element.closest('#rank-panel')), true);
    assert.equal(await page.locator('#stream-log .stream-log-row').count(), 6);
    assert.equal(await page.locator('#stream-log .stream-log-row.found').count(), 1);
    for (const [width, height] of [[1440, 1000], [1024, 768], [768, 600], [390, 844], [320, 568], [844, 390]]) {
      await page.setViewportSize({ width, height });
      const fits = await page.locator('#candidate-stream').evaluate(element => {
        const rect = element.getBoundingClientRect(), panel = element.closest('#rank-panel').getBoundingClientRect();
        return rect.right <= panel.right && rect.left >= panel.left && element.scrollWidth <= element.clientWidth;
      });
      assert.equal(fits, true, `Fluxo no painel do ranking: ${width}x${height}`);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await checkTooltip(page.locator('#candidate-stream .info'), `Informativo do ranking ${width}x${height}`);
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    assert.match(await page.locator('#metric-time').evaluate(element => element.firstChild.textContent), /^\d+,\d$/);
    assert.match(await page.locator('#results-body tr').first().locator('td').nth(1).textContent(), /^\d+,\d s$/);
    assert.equal(await page.locator('#cancel-button').isDisabled(), true);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    assert.equal(overflow, false);
    fs.mkdirSync(path.join(__dirname, '../test-results'), { recursive: true });
    await page.waitForFunction(() => !document.getAnimations().some(animation => animation.playState === 'running' && animation.effect?.target?.id === 'stream-word'));
    await page.screenshot({ path: path.join(__dirname, '../test-results/desktop.png'), fullPage: true });
    await page.locator('#engineering').screenshot({ path: path.join(__dirname, '../test-results/code-showcase.png') });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: path.join(__dirname, '../test-results/mobile.png'), fullPage: true });
    assert.equal(await page.locator('#rank-panel .rank-step:visible').count(), 3);
    await page.locator('#rank-panel').screenshot({ path: path.join(__dirname, '../test-results/rank-mobile.png') });
    mode = 'running';
    await page.evaluate(() => {
      window.wordTicks = []; window.hashTicks = [];
      new MutationObserver(() => window.wordTicks.push(performance.now())).observe(document.getElementById('stream-word'), { childList: true });
      new MutationObserver(() => window.hashTicks.push(performance.now())).observe(document.getElementById('stream-hash'), { childList: true });
    });
    await page.locator('[data-algorithm="md5"]').click();
    await page.locator('#run-button').click();
    await page.waitForFunction(() => !!document.getElementById('candidate-stream').closest('.chart-heading'));
    assert.equal(await page.locator('#candidate-stream').evaluate(element => !!element.closest('.chart-heading')), true);
    await page.waitForFunction(() => document.getElementById('execution-status').textContent === 'EM EXECUÇÃO');
    await page.waitForFunction(() => document.getElementById('stream-word').textContent.startsWith('papoca'));
    const liveSample = await page.locator('#candidate-stream').evaluate(element => ({
      word: element.querySelector('#stream-word').textContent,
      hash: element.querySelector('#stream-hash').title
    }));
    assert.equal(liveSample.hash, createHash('md5').update(liveSample.word).digest('hex'));
    assert.equal(await page.locator('#stream-status').textContent(), 'BUSCA EM CURSO');
    await page.waitForFunction(() => window.wordTicks.length >= 25);
    const tickCounts = await page.evaluate(() => [window.wordTicks.length, window.hashTicks.length]);
    assert.equal(tickCounts[0], tickCounts[1], 'Palavras e hashes mudam juntos');
    const medianGap = await page.evaluate(() => {
      const gaps = window.wordTicks.slice(1).map((time, index) => time - window.wordTicks[index]).sort((a, b) => a - b);
      return gaps[Math.floor(gaps.length / 2)];
    });
    assert.ok(medianGap <= 50, `Rajada de palavras: intervalo mediano ${medianGap} ms`);
    await page.waitForFunction(() => new Set(window.chartFrames.filter(frame => frame.endpoints.length === 4).map(frame => frame.endpoints.at(-1).x.toFixed(2))).size >= 12);
    const motion = await page.evaluate(() => {
      const points = window.chartFrames.filter(frame => frame.endpoints.length === 4).map(frame => frame.endpoints.at(-1).x);
      return { monotonic: points.every((x, index) => !index || x >= points[index - 1] - .1), drops: points.slice(1).map((x, index) => ({ before: points[index], after: x })).filter(pair => pair.after < pair.before - .1).slice(0, 5) };
    });
    assert.equal(motion.monotonic, true, `O gráfico avança entre amostras sem reiniciar o desenho: ${JSON.stringify(motion.drops)}`);
    await page.locator('#candidate-stream').screenshot({ path: path.join(__dirname, '../test-results/live-candidates.png') });
    await page.locator('.chart-panel').screenshot({ path: path.join(__dirname, '../test-results/compact-search.png') });
    await page.locator('#cancel-button').click();
    await page.waitForFunction(() => document.getElementById('execution-status').textContent === 'INTERROMPIDA');
    assert.equal(await page.locator('#stream-status').textContent(), 'INTERROMPIDA');
    mode = 'timeout';
    await page.locator('[data-algorithm="argon2id"]').click();
    await page.locator('#timeout-seconds').fill('0.5');
    await page.locator('#run-button').click();
    await page.waitForFunction(() => document.getElementById('execution-status').textContent === 'TEMPO LIMITE');
    assert.equal(await page.locator('#stream-status').textContent(), 'TEMPO LIMITE');
    assert.match(await page.locator('#result-banner').textContent(), /prazo terminou/);
    mode = 'found';
    await page.locator('[data-algorithm="md5"]').click();
    await page.locator('#execution-gpu').check();
    assert.equal(await page.locator('#rank-button').isHidden(), true);
    assert.equal(await page.locator('#cpu-workers-field').isHidden(), true);
    assert.equal(await page.locator('#gpu-device-field').isVisible(), true);
    assert.equal(await page.locator('input[name="engine"]:checked').inputValue(), 'gpu-hashcat');
    await page.locator('#run-button').click();
    await page.waitForFunction(() => document.getElementById('stream-status').textContent === 'PALAVRA ENCONTRADA');
    assert.equal([...jobs.values()].at(-1).device, 'gpu');
    assert.equal(await page.locator('#stream-hash-label').textContent(), 'HASH ALVO');
    online = false;
    await page.locator('#server-status').click();
    await page.waitForFunction(() => document.getElementById('status-text').textContent === 'Servidor offline');
    assert.equal(await page.locator('#prepare-button').isDisabled(), true);
    online = true;
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.reload();
    await page.waitForFunction(() => document.getElementById('status-text').textContent === 'Servidor online');
    assert.equal(await page.locator('.code-card[data-reveal="pending"]').count(), 0);
    await page.locator('#master-word').fill('abc');
    await page.locator('#prepare-button').click();
    await page.locator('#prepared-result').waitFor({ state: 'visible' });
    mode = 'found';
    await page.locator('[data-algorithm="md5"]').click();
    await page.locator('#execution-cpu').check();
    await page.locator('#run-button').click();
    await page.waitForFunction(() => document.getElementById('stream-status').textContent === 'PALAVRA ENCONTRADA');
    assert.equal(await page.locator('#stream-word').evaluate(element => element.getAnimations().length), 0, 'Preferência de movimento reduzido respeitada');
    assert.equal(await page.locator('#stream-hash').evaluate(element => element.getAnimations().length), 0, 'Hash respeita movimento reduzido');
    assert.deepEqual(errors, []);
    console.log('UI: ranking manual de três motores, alternador CPU/GPU, animação de candidatos e gráfico passaram em seis tamanhos de tela (API com fixtures).');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
