/* Interface local: todo resultado vem da API; animações só afetam o desenho. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const API = 'http://127.0.0.1:8765/api';
  const names = { md5: 'MD5', sha512: 'SHA-512', bcrypt: 'bcrypt', argon2id: 'Argon2id' };
  const engineNames = { 'python-iterative': 'Python iterativo', 'python-recursive': 'Python recursivo', rust: 'Rust paralelo', 'gpu-hashcat': 'Hashcat · GPU' };
  const colors = { 'python-iterative': '#8db6fa', 'python-recursive': '#9fcaba', rust: '#c4aedb', 'gpu-hashcat': '#e3bf8b' };
  const explanations = {
    md5: 'MD5 gera um digest de 128 bits. A busca calcula o digest de cada candidato e compara com o alvo.',
    sha512: 'SHA-512 gera um digest de 512 bits. Mais bits não permitem prever a posição da palavra na lista.',
    bcrypt: 'bcrypt usa salt aleatório e custo exponencial. Neste laboratório o custo é 4, identificado por $2b$04$.',
    argon2id: 'Argon2id combina memória e processamento: 8 MiB, duas passagens e uma lane por tentativa neste laboratório.'
  };
  const terminal = new Set(['found', 'exhausted', 'cancelled', 'timeout', 'error']);
  const rankEngines = ['python-iterative', 'python-recursive', 'rust'];
  const statusNames = { queued: 'NA FILA', preparing: 'PREPARANDO MOTOR', running: 'EM EXECUÇÃO', found: 'PALAVRA ENCONTRADA', exhausted: 'LISTA ESGOTADA', cancelled: 'INTERROMPIDA', timeout: 'TEMPO LIMITE', error: 'ERRO DE EXECUÇÃO' };
  const state = { online: false, experiment: null, health: null, algorithm: 'md5', jobs: new Map(), active: [], current: null, rank: null, busy: false, preparing: false, toastTimer: null, polling: false };
  const number = value => new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 0 }).format(value || 0);
  const decimal = (value, digits = 2) => new Intl.NumberFormat('pt-BR', { maximumFractionDigits: digits, minimumFractionDigits: digits }).format(value || 0);
  const seconds = value => `${decimal(value, 1)} s`;
  const rankSeconds = value => `${decimal(value, 3)} s`;
  const device = () => document.querySelector('input[name="execution-device"]:checked')?.value || 'cpu';
  const visibleJobs = () => state.rank ? state.rank.jobIds.map(id => state.jobs.get(id)).filter(Boolean) : [...state.jobs.values()];
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const stream = new CandidateStream();

  async function request(path, options = {}) {
    const response = await fetch(API + path, { ...options, headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers }, signal: options.signal || AbortSignal.timeout(8000) });
    let data;
    try { data = await response.json(); } catch { throw new Error('O servidor retornou uma resposta inesperada.'); }
    if (!response.ok) { const error = new Error(typeof data.detail === 'string' ? data.detail : 'Confira os campos informados.'); error.status = response.status; throw error; }
    return data;
  }
  function toast(message) {
    $('toast').textContent = message;
    $('toast').hidden = false;
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => { $('toast').hidden = true; }, 4000);
  }
  function message(element, text, error = false) { element.textContent = text; element.classList.toggle('error', error); }
  function controls() {
    const gpu = device() === 'gpu';
    const rankPending = state.rank && !state.rank.done;
    $('prepare-button').disabled = !state.online || state.busy || state.preparing || rankPending;
    $('run-button').disabled = !state.online || !state.experiment || state.busy || rankPending || (gpu && !state.health?.gpu_engine?.available);
    $('rank-button').disabled = !state.online || !state.experiment || state.busy || rankPending || !state.health?.engines.every(engine => engine.available);
    $('rank-button').hidden = gpu;
    $('rank-next').disabled = !state.online || state.busy;
    $('rank-exit').disabled = state.busy;
    $('cancel-button').disabled = !state.busy || !state.online;
  }
  async function health() {
    try {
      const data = await request('/health', { signal: AbortSignal.timeout(2500) });
      if (data.service !== 'PapocaHash') throw new Error('Outro serviço está usando a porta 8765.');
      if (state.health?.instance_id && data.instance_id !== state.health.instance_id) {
        state.experiment = null; state.busy = false; state.active = []; state.rank = null;
        stream.reset();
        renderRank();
        $('prepared-result').hidden = true;
        toast('O servidor reiniciou. Prepare sua palavra novamente.');
      }
      const wasOnline = state.online;
      const capabilityChanged = JSON.stringify(state.health?.gpu_engine) !== JSON.stringify(data.gpu_engine);
      state.online = true;
      state.health = data;
      $('server-status').className = 'server-status online';
      $('status-text').textContent = data.engines.every(engine => engine.available) ? 'Servidor online' : 'Online · Rust pendente';
      $('worker-count').max = data.workers;
      if (!wasOnline) {
        $('worker-count').value = data.workers;
        renderEngines();
        if (!state.experiment) message($('prepare-message'), `${data.workers} processadores disponíveis. Prepare sua palavra para começar.`);
      }
      if (capabilityChanged && wasOnline) renderEngines();
      const gpu = data.gpu;
      $('metric-gpu').replaceChildren(document.createTextNode(gpu.available ? decimal(gpu.usage, 0) : '—'), Object.assign(document.createElement('small'), { textContent: '%' }));
      $('gpu-name').textContent = gpu.available ? `${gpu.name.replace('NVIDIA GeForce ', '')} · global` : 'Telemetria indisponível · busca na CPU';
    } catch {
      state.online = false;
      if (state.busy) stream.pause();
      $('server-status').className = 'server-status offline';
      $('status-text').textContent = 'Servidor offline';
      if (!state.experiment && !state.preparing) message($('prepare-message'), 'Inicie server.bat. O laboratório se conecta automaticamente.');
    }
    controls();
  }
  function displayHash() {
    if (!state.experiment) return;
    $('generated-hash').textContent = state.experiment.targets[$('hash-algorithm').value];
  }
  function renderEngines() {
    const gpu = device() === 'gpu';
    const capability = state.health?.gpu_engine;
    $('gpu-availability').textContent = capability?.available ? 'Pronta' : capability ? 'Indisponível' : 'Verificando';
    $('cpu-workers-field').hidden = gpu;
    $('gpu-device-field').hidden = !gpu;
    $('worker-count').disabled = gpu;
    $('engine-options').classList.toggle('gpu-options', gpu);
    const selectedGpu = $('gpu-device').value;
    $('gpu-device').replaceChildren(...(capability?.devices || []).map(device => Object.assign(document.createElement('option'), { value: String(device.id), textContent: device.name })));
    if ([...$('gpu-device').options].some(option => option.value === selectedGpu)) $('gpu-device').value = selectedGpu;
    $('device-message').textContent = gpu ? capability?.available ? 'Hashes na GPU. A CPU coordena a execução.' : capability?.reason || 'Inicie server.bat para preparar a GPU.' : 'Todos os processadores disponíveis por padrão.';
    const fallback = [
      { id: 'python-iterative', name: 'Python iterativo', strategy: 'Laço · multiprocessos', lines: null, available: false },
      { id: 'python-recursive', name: 'Python recursivo', strategy: 'Recursão · multiprocessos', lines: null, available: false },
      { id: 'rust', name: 'Rust paralelo', strategy: 'Múltiplas threads', lines: null, available: false }
    ];
    const container = $('engine-options');
    const previous = container.querySelector('input:checked')?.value;
    const selected = gpu ? 'gpu-hashcat' : previous && previous !== 'gpu-hashcat' ? previous : 'python-iterative';
    container.replaceChildren();
    const engines = gpu ? [{ id: 'gpu-hashcat', name: 'Hashcat · GPU', strategy: 'OpenCL · placa selecionada', available: capability?.available }] : state.health?.engines || fallback;
    for (const engine of engines) {
      const label = document.createElement('label');
      label.className = `engine-option${engine.available ? '' : ' unavailable'}`;
      const input = Object.assign(document.createElement('input'), { type: 'radio', name: 'engine', value: engine.id, checked: engine.id === selected, disabled: !engine.available });
      const title = Object.assign(document.createElement('b'), { textContent: engine.name });
      const subtitle = Object.assign(document.createElement('small'), { textContent: engine.available ? engine.strategy : 'Aguardando preparo' });
      const tags = Object.assign(document.createElement('div'), { className: 'engine-tags' });
      for (const text of gpu ? ['OpenCL', 'GPU'] : ['O(n × H)', engine.lines == null ? '— linhas' : `${engine.lines} linhas`]) tags.append(Object.assign(document.createElement('span'), { textContent: text }));
      const info = Object.assign(document.createElement('button'), { type: 'button', className: 'info', textContent: 'i' });
      info.dataset.tip = gpu ? 'Hashcat é um motor externo com kernels OpenCL. GPU não executa os núcleos Python ou Rust. O tempo medido inclui inicialização e compilação; a CPU coordena leitura e envio de candidatos. Os kernels podem ser reaproveitados em execuções seguintes.' : 'n é o número de candidatos; H é o custo de verificar um hash. Linhas contam o núcleo, sem comentários, bibliotecas ou orquestração. A recursão tem profundidade logarítmica por bloco.';
      info.setAttribute('aria-label', 'Sobre complexidade e linhas do núcleo');
      tags.append(info);
      label.append(input, title, subtitle, tags);
      container.append(label);
    }
  }
  document.querySelectorAll('input[name="execution-device"]').forEach(input => input.addEventListener('change', () => { renderEngines(); controls(); }));
  $('prepare-form').addEventListener('submit', async event => {
    event.preventDefault();
    if (state.preparing || state.busy) return;
    const word = $('master-word').value;
    if (!word || new TextEncoder().encode(word).length > 72 || /[\r\n\0]/.test(word)) {
      message($('prepare-message'), 'Use de 1 a 72 bytes UTF-8, sem quebras de linha. Acentos podem ocupar mais de um byte.', true);
      return;
    }
    state.preparing = true;
    controls();
    $('prepare-button').textContent = 'Preparando a wordlist…';
    message($('prepare-message'), 'Inserindo a palavra e preparando os quatro hashes no servidor.');
    try {
      const experiment = await request('/experiments', { method: 'POST', body: JSON.stringify({ word }), signal: AbortSignal.timeout(30000) });
      state.experiment = experiment;
      state.jobs.clear();
      state.active = [];
      state.current = null;
      state.rank = null;
      stream.reset();
      renderRank();
      displayHash();
      $('prepared-result').hidden = false;
      $('insertion-text').textContent = `Palavra adicionada à wordlist1kk na posição ${number(experiment.position)}. Exatamente 1.000.000 de entradas distintas.`;
      message($('prepare-message'), 'Experimento pronto. Escolha um card para observar a busca.');
      $('result-banner').hidden = true;
      $('execution-status').textContent = 'EXPERIMENTO PREPARADO';
      renderTable();
      renderLegend();
      chart.animate();
    } catch (error) { message($('prepare-message'), error.message === 'Failed to fetch' ? 'Não foi possível conectar. Confira se server.bat está aberto.' : error.message, true); }
    finally {
      state.preparing = false;
      $('prepare-button').replaceChildren(document.createTextNode('Preparar experimento '), Object.assign(document.createElement('span'), { textContent: '↗' }));
      controls();
    }
  });
  $('hash-algorithm').addEventListener('change', displayHash);
  $('copy-hash').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText($('generated-hash').textContent); toast('Hash copiado.'); }
    catch { const range = document.createRange(); range.selectNodeContents($('generated-hash')); getSelection().removeAllRanges(); getSelection().addRange(range); toast('Hash selecionado. Use Ctrl+C para copiar.'); }
  });
  $('server-status').addEventListener('click', health);
  const complexities = {
    md5: 'O(n × L)', sha512: 'O(n × L)',
    bcrypt: 'O(n × 2^c)', argon2id: 'O(n × m × t)'
  };
  document.querySelectorAll('.algorithm-card').forEach(card => {
    const complexity = Object.assign(document.createElement('span'), {
      className: 'card-complexity', textContent: `BIG O · ${complexities[card.dataset.algorithm]}`
    });
    card.querySelector('.card-bottom').before(complexity);
    const detail = Object.assign(document.createElement('span'), { className: 'info', textContent: 'i' });
    detail.dataset.tip = explanations[card.dataset.algorithm];
    detail.setAttribute('aria-hidden', 'true');
    card.querySelector('.card-title > span').append(document.createTextNode(' '), detail);
    card.setAttribute('aria-label', `${names[card.dataset.algorithm]}. Busca ${complexities[card.dataset.algorithm]}. ${explanations[card.dataset.algorithm]} Abrir configuração.`);
    card.addEventListener('click', () => {
    state.algorithm = card.dataset.algorithm;
    $('dialog-title').replaceChildren(document.createTextNode(names[state.algorithm]), Object.assign(document.createElement('em'), { textContent: ' / selecione o motor' }));
    $('target-hash').value = state.experiment?.targets[state.algorithm] || '';
    $('engine-dialog').querySelector('.dialog-description').textContent = explanations[state.algorithm];
    renderEngines();
    message($('dialog-message'), state.experiment ? 'Busca real, sem consultar a posição da palavra.' : 'Prepare a palavra mestra antes de iniciar uma execução.');
    controls();
    $('engine-dialog').showModal();
    });
  });
  document.querySelectorAll('.code-tags > span').forEach(tag => {
    if (tag.textContent.startsWith('O(')) {
      tag.textContent = `BIG O · ${tag.textContent}`;
      tag.classList.add('big-o-tag');
    }
  });
  const recursiveTags = document.querySelector('.code-card:nth-child(2) .code-tags');
  recursiveTags.querySelector('.info').before(Object.assign(document.createElement('span'), {
    className: 'big-o-tag', textContent: 'BIG O · O(n × H)'
  }));
  $('engine-dialog').addEventListener('click', event => {
    const rect = $('engine-dialog').getBoundingClientRect();
    if (event.target === $('engine-dialog') && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom)) $('engine-dialog').close();
  });
  function renderRank() {
    const rank = state.rank;
    $('rank-panel').hidden = !rank;
    const destination = rank ? $('rank-stream-slot') : stream.home;
    if (stream.root.parentElement !== destination) destination.append(stream.root);
    stream.root.classList.toggle('ranked', !!rank);
    if (!rank) return;
    const jobs = rank.jobIds.map(id => state.jobs.get(id));
    const comparable = jobs.filter(job => job && ['found', 'exhausted'].includes(job.status) && job.elapsed > 0).sort((a, b) => a.elapsed - b.elapsed);
    const completed = rank.done && comparable.length === 3;
    const best = completed ? comparable[0] : null;
    $('rank-progress').textContent = `RANKING · ${rank.index + 1} / 3`;
    $('rank-context').textContent = `${names[rank.payload.algorithm]} · ${rank.payload.workers} trabalhadores · mesmo hash de destino`;
    $('rank-phase').textContent = rank.error ? 'FALHA AO INICIAR' : rank.launching ? 'INICIANDO MOTOR' : rank.done ? 'RANKING CONCLUÍDO' : rank.waiting ? 'AGUARDANDO PRÓXIMO' : 'MOTOR EM EXECUÇÃO';
    const steps = $('rank-steps');
    steps.replaceChildren();
    rankEngines.forEach((engine, index) => {
      const job = jobs[index];
      const finished = job && terminal.has(job.status);
      const valid = job && ['found', 'exhausted'].includes(job.status);
      const card = Object.assign(document.createElement('article'), { className: 'rank-step' });
      card.dataset.state = !job ? 'pending' : !finished ? 'running' : valid ? 'done' : 'error';
      const top = Object.assign(document.createElement('div'), { className: 'rank-step-top' });
      top.append(Object.assign(document.createElement('span'), { textContent: `0${index + 1} / MOTOR` }));
      if (completed && valid) top.append(Object.assign(document.createElement('span'), { className: 'rank-step-place', textContent: `#${comparable.indexOf(job) + 1}` }));
      const title = Object.assign(document.createElement('h4'), { textContent: engineNames[engine] });
      const value = Object.assign(document.createElement('strong'), { className: 'rank-step-value', textContent: job?.elapsed ? rankSeconds(job.elapsed) : '—' });
      const detail = Object.assign(document.createElement('span'), { className: 'rank-step-detail', textContent: !job ? 'Aguardando início manual' : `${number(job.attempts)} tentativas · ${number(job.rate || (job.elapsed ? job.attempts / job.elapsed : 0))}/s · ${statusNames[job.status] || job.status}` });
      card.append(top, title, value, detail);
      if (completed && valid) card.append(Object.assign(document.createElement('span'), { className: 'rank-step-delta', textContent: job === best ? 'REFERÊNCIA · MAIS RÁPIDO' : `+${decimal((job.elapsed / best.elapsed - 1) * 100, 1)}% de tempo` }));
      steps.append(card);
    });
    $('rank-summary').textContent = rank.error || (completed ? `Mais rápido: ${engineNames[best.engine]} em ${rankSeconds(best.elapsed)}. ${engineNames[comparable.at(-1).engine]} levou ${decimal(comparable.at(-1).elapsed / best.elapsed, 2)}× esse tempo.` : rank.done ? 'Ranking encerrado com resultado parcial. Veja o estado de cada motor acima.' : rank.waiting ? `Etapa ${rank.index + 1} encerrada. Clique em Próximo para iniciar ${engineNames[rankEngines[rank.index + 1]]}.` : 'Os resultados aparecem aqui, um motor por vez.');
    $('rank-next').hidden = !rank.waiting || rank.done;
    $('rank-next').replaceChildren(document.createTextNode(`Próximo · ${engineNames[rankEngines[rank.index + 1]] || ''} `), Object.assign(document.createElement('span'), { textContent: '↗' }));
    $('rank-exit').textContent = rank.done ? 'Fechar ranking' : 'Encerrar ranking';
  }
  async function start(rankMode = false) {
    if (state.busy || !state.experiment || !state.online || (state.rank && !state.rank.done)) return;
    const selectedDevice = device();
    const gpu = selectedDevice === 'gpu';
    const workers = gpu ? 1 : Number($('worker-count').value);
    const gpuDevice = gpu ? Number($('gpu-device').value) : null;
    const timeout = $('timeout-seconds').value === '' ? null : Number($('timeout-seconds').value);
    const target = $('target-hash').value.trim();
    const selected = document.querySelector('input[name="engine"]:checked')?.value;
    if (!target || !Number.isInteger(workers) || workers < 1 || workers > state.health.workers || (gpu && (!state.health.gpu_engine?.available || !gpuDevice)) || (timeout !== null && (!Number.isFinite(timeout) || timeout <= 0 || timeout > 604800)) || !selected || (rankMode && (gpu || !state.health.engines.every(engine => engine.available)))) {
      message($('dialog-message'), 'Confira o hash, o motor, os trabalhadores e o timeout.', true);
      return;
    }
    const payload = { experiment_id: state.experiment.id, algorithm: state.algorithm, target, workers, timeout, device: selectedDevice, gpu_device_id: gpuDevice };
    state.busy = true;
    controls();
    try {
      const engine = rankMode ? rankEngines[0] : selected;
      const job = await request('/jobs', { method: 'POST', body: JSON.stringify({ ...payload, engine }) });
      state.jobs.set(job.id, job);
      state.active = [job.id]; state.current = job.id;
      state.rank = rankMode ? { payload, index: 0, jobIds: [job.id], waiting: false, done: false, launching: false, error: '' } : null;
      stream.update(job, `${names[state.algorithm]} · ${engineNames[engine]}`);
      $('engine-dialog').close();
      $('result-banner').hidden = true;
      $('observatory').scrollIntoView({ behavior: reduced ? 'instant' : 'smooth', block: 'start' });
      renderRank();
      renderTable();
      renderLegend();
      chart.animate();
      await poll();
    } catch (error) {
      message($('dialog-message'), error.message, true);
      state.busy = false; controls();
    }
  }
  $('run-button').addEventListener('click', () => start());
  $('rank-button').addEventListener('click', () => start(true));
  $('rank-next').addEventListener('click', async () => {
    const rank = state.rank;
    if (!rank?.waiting || rank.done || state.busy || !state.online) return;
    rank.waiting = false; rank.launching = true; rank.error = '';
    state.busy = true; controls(); renderRank();
    try {
      const index = rank.index + 1;
      const engine = rankEngines[index];
      const job = await request('/jobs', { method: 'POST', body: JSON.stringify({ ...rank.payload, engine }) });
      rank.index = index; rank.jobIds.push(job.id); rank.launching = false;
      state.jobs.set(job.id, job);
      state.active = [job.id]; state.current = job.id;
      $('result-banner').hidden = true;
      stream.update(job, `${names[job.algorithm]} · ${engineNames[engine]}`);
      renderRank(); renderTable(); renderLegend(); chart.animate();
      await poll();
    } catch (error) {
      rank.launching = false; rank.waiting = true; rank.error = `Não foi possível iniciar o próximo motor: ${error.message}`;
      state.busy = false; renderRank(); controls();
    }
  });
  $('rank-exit').addEventListener('click', () => {
    if (state.busy) return;
    state.rank = null;
    renderRank(); renderTable(); renderLegend(); chart.animate(); controls();
  });
  $('cancel-button').addEventListener('click', async () => {
    $('cancel-button').disabled = true;
    try { await Promise.all(state.active.filter(id => !terminal.has(state.jobs.get(id)?.status)).map(id => request(`/jobs/${id}/cancel`, { method: 'POST', body: '{}' }))); toast('Interrupção solicitada para o motor atual.'); }
    catch { toast('Não foi possível solicitar a interrupção. Verifique o servidor.'); }
  });
  async function poll() {
    if (state.polling || !state.busy) return;
    state.polling = true;
    try {
      for (const id of state.active) {
        if (terminal.has(state.jobs.get(id)?.status)) continue;
        state.jobs.set(id, await request(`/jobs/${id}`, { signal: AbortSignal.timeout(3000) }));
      }
      const jobs = state.active.map(id => state.jobs.get(id));
      const current = jobs.find(job => ['preparing', 'running'].includes(job.status)) || jobs.find(job => !terminal.has(job.status)) || jobs.at(-1);
      if (current) { state.current = current.id; metrics(current); }
      chart.animate();
      renderTable();
      if (state.rank) renderRank();
      if (jobs.every(job => terminal.has(job.status))) {
        state.busy = false;
        if (state.rank) {
          state.rank.waiting = state.rank.index < rankEngines.length - 1;
          state.rank.done = !state.rank.waiting;
          renderRank();
          finish(state.rank.done ? visibleJobs() : jobs);
        } else finish(jobs);
      }
    } catch (error) {
      if (error.status === 404) {
        stream.pause('O servidor reiniciou. Prepare um novo experimento.');
        state.busy = false; state.experiment = null; $('prepared-result').hidden = true;
        state.rank = null; renderRank();
        $('execution-status').textContent = 'SERVIDOR REINICIADO';
        toast('A execução não existe mais no servidor. Prepare a palavra novamente.');
      } else { $('execution-status').textContent = 'CONEXÃO INTERROMPIDA · RECONECTANDO'; stream.pause(); }
    }
    finally { state.polling = false; controls(); if (state.busy) setTimeout(poll, 180); }
  }
  function metrics(job) {
    const elapsed = job.elapsed || 0, attempts = job.attempts || 0;
    $('metric-time').replaceChildren(document.createTextNode(decimal(elapsed, 1)), Object.assign(document.createElement('small'), { textContent: 's' }));
    stream.update(job, `${names[job.algorithm]} · ${engineNames[job.engine]}`);
    $('metric-rate').textContent = number(job.rate || (elapsed ? attempts / elapsed : 0));
    $('metric-attempts').textContent = `${number(attempts)} candidatos testados`;
    $('metric-engine').textContent = `${names[job.algorithm]} · ${engineNames[job.engine]} · ${job.device === 'gpu' ? 'tempo com inicialização' : `${job.workers} trabalhadores`}`;
    const cpu = terminal.has(job.status) ? job.cpu_average : job.cpu;
    $('metric-cpu').replaceChildren(document.createTextNode(cpu == null ? '—' : decimal(cpu, 0)), Object.assign(document.createElement('small'), { textContent: '%' }));
    $('metric-memory').textContent = `Memória: ${decimal(job.memory_mb || job.memory_peak_mb, 1)} MiB`;
    $('execution-status').textContent = statusNames[job.status] || job.status;
    $('execution-status').classList.toggle('running', ['preparing', 'running'].includes(job.status));
    $('progress-fill').style.width = `${Math.min(100, attempts / job.count * 100)}%`;
    $('progress-text').textContent = `${number(attempts)} / ${number(job.count)}`;
    const rate = elapsed ? attempts / elapsed : 0;
    const eta = rate ? (job.count - attempts) / rate : null;
    $('eta-text').textContent = terminal.has(job.status) ? 'Execução encerrada' : eta === null ? 'Estimativa: —' : `Até esgotar: ~${eta > 3600 ? decimal(eta / 3600, 1) + ' h' : eta > 60 ? decimal(eta / 60, 1) + ' min' : seconds(eta)}`;
  }
  function finish(jobs) {
    const banner = $('result-banner');
    const found = jobs.find(job => job.status === 'found');
    banner.hidden = false;
    banner.classList.toggle('error', !found);
    if (found) {
      const fastest = jobs.filter(job => job.status === 'found').sort((a, b) => a.elapsed - b.elapsed)[0];
      banner.textContent = `✓ Palavra encontrada: “${found.word}” · posição ${number(found.position)}. ${jobs.length > 1 ? `Menor tempo: ${engineNames[fastest.engine]}, ${seconds(fastest.elapsed)}. ` : `Busca: ${seconds(found.elapsed)}. `}Tentativas e ordem podem variar com o paralelismo.`;
    } else {
      const error = jobs.find(job => job.status === 'error');
      banner.textContent = error ? `A execução encontrou um problema: ${error.error}` : jobs.some(job => job.status === 'timeout') ? 'O prazo terminou. A busca foi interrompida; a palavra pode estar em candidatos ainda não verificados.' : jobs.every(job => job.status === 'exhausted') ? 'Lista esgotada. Nenhum dos candidatos corresponde ao hash informado.' : 'Experimento interrompido. Os resultados parciais permanecem disponíveis.';
    }
    renderTable();
  }
  function renderTable() {
    const jobs = visibleJobs().filter(job => terminal.has(job.status));
    const body = $('results-body');
    body.replaceChildren();
    if (!jobs.length) { const row = body.insertRow(); row.className = 'empty-row'; const cell = row.insertCell(); cell.colSpan = 6; cell.textContent = 'As evidências aparecem aqui, uma execução por vez.'; }
    for (const job of jobs) {
      const row = body.insertRow();
      const fields = [`${names[job.algorithm]} / ${engineNames[job.engine]}`, job.elapsed ? seconds(job.elapsed) : '—', job.rate ? `${number(job.rate)}/s` : '—', job.cpu_average == null ? '—' : `${decimal(job.cpu_average, 0)}% / ${job.cpu_peak == null ? '—' : decimal(job.cpu_peak, 0) + '%'}`, job.memory_peak_mb === undefined ? '—' : `${decimal(job.memory_peak_mb, 1)} MiB`];
      fields.forEach(text => { row.insertCell().textContent = text; });
      const status = Object.assign(document.createElement('span'), { className: `table-state ${job.status}`, textContent: statusNames[job.status] });
      row.insertCell().append(status);
      row.title = `Dispositivo: ${job.device === 'gpu' ? 'GPU · tempo inclui inicialização/compilação' : 'CPU'} · Trabalhadores: ${job.workers} · Tentativas: ${number(job.attempts)}${job.match_seconds == null ? '' : ` · Até encontrar: ${seconds(job.match_seconds)}`} · Preparo: ${job.setup_seconds == null ? 'incluído no total' : seconds(job.setup_seconds)} · Total: ${seconds(job.total_seconds || 0)}${job.stop_latency == null ? '' : ` · Latência de parada: ${seconds(job.stop_latency)}`}`;
    }
    $('export-results').disabled = !jobs.length;
  }
  function renderLegend() {
    const legend = $('chart-legend');
    legend.replaceChildren();
    const jobs = visibleJobs();
    const seen = new Set();
    for (const job of jobs) {
      const key = `${job.algorithm}:${job.engine}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const span = Object.assign(document.createElement('span'), { className: 'legend-item' });
      const dot = document.createElement('i'); dot.style.background = colors[job.engine];
      span.append(dot, document.createTextNode(`${jobs.some(other => other.algorithm !== job.algorithm) ? names[job.algorithm] + ' · ' : ''}${engineNames[job.engine]}`));
      legend.append(span);
    }
    if (!jobs.length) legend.append(Object.assign(document.createElement('span'), { className: 'legend-empty', textContent: 'MEDIÇÕES REAIS' }));
  }
  $('export-results').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify({ exported_at: new Date().toISOString(), experiment: state.experiment, jobs: [...state.jobs.values()] }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = Object.assign(document.createElement('a'), { href: url, download: `papocahash-${state.experiment.id.slice(0, 8)}.json` });
    link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  class PerformanceChart {
    constructor(canvas) {
      this.canvas = canvas; this.context = canvas.getContext('2d'); this.frame = null; this.hover = null; this.points = [];
      this.plotJobs = []; this.scaleY = .001;
      new ResizeObserver(() => this.draw()).observe(canvas);
      canvas.addEventListener('pointermove', event => {
        const rect = canvas.getBoundingClientRect();
        const x = event.clientX - rect.left, y = event.clientY - rect.top;
        this.hover = this.points.reduce((best, point) => Math.hypot(point.x - x, point.y - y) < (best?.distance ?? 22) ? { ...point, distance: Math.hypot(point.x - x, point.y - y) } : best, null);
        this.draw();
      });
      canvas.addEventListener('pointerleave', () => { this.hover = null; this.draw(); });
    }
    animate() {
      if (this.frame) cancelAnimationFrame(this.frame);
      this.frame = null;
      const targets = visibleJobs().filter(job => job.samples?.length > 1).map(job => ({
        ...job, samples: job.samples.filter(sample => Number.isFinite(sample.elapsed) && Number.isFinite(sample.attempts))
      }));
      if (!targets.length) { this.plotJobs = []; this.hover = null; this.scaleY = .001; this.draw(); return; }
      const key = sample => `${sample.attempts}:${sample.elapsed}`;
      const starts = new Map(this.plotJobs.map(job => [job.id, job]));
      const transitions = targets.map(job => {
        const previous = starts.get(job.id)?.points || [];
        const positions = new Map(previous.map(point => [key(point.sample), point]));
        const tail = previous.at(-1) || { attempts: 0, elapsed: 0 };
        const origin = sample => {
          if (positions.has(key(sample))) return positions.get(key(sample));
          const upper = previous.findIndex(point => point.sample.attempts >= sample.attempts);
          if (upper < 1) return upper === 0 ? previous[0] : tail;
          const a = previous[upper - 1], b = previous[upper];
          const fraction = (sample.attempts - a.sample.attempts) / (b.sample.attempts - a.sample.attempts || 1);
          return { attempts: a.attempts + (b.attempts - a.attempts) * fraction, elapsed: a.elapsed + (b.elapsed - a.elapsed) * fraction };
        };
        return { job, from: job.samples.map(origin) };
      });
      const targetY = Math.max(.001, ...targets.flatMap(job => job.samples.map(sample => sample.elapsed))) * 1.15;
      const startY = this.plotJobs.length ? this.scaleY : targetY;
      const start = performance.now();
      // Partir do desenho atual preserva a continuidade quando chega uma amostra.
      const step = now => {
        const t = reduced ? 1 : Math.min(1, (now - start) / 520), ease = 1 - (1 - t) ** 3;
        this.scaleY = startY + (targetY - startY) * ease;
        this.plotJobs = transitions.map(({ job, from }) => ({ ...job, points: job.samples.map((sample, index) => ({
          sample, attempts: from[index].attempts + (sample.attempts - from[index].attempts) * ease,
          elapsed: from[index].elapsed + (sample.elapsed - from[index].elapsed) * ease
        })) }));
        this.draw();
        if (t < 1) this.frame = requestAnimationFrame(step); else this.frame = null;
      };
      this.frame = requestAnimationFrame(step);
    }
    draw() {
      const rect = this.canvas.getBoundingClientRect(), dpr = devicePixelRatio || 1;
      if (rect.width < 1 || rect.height < 1) return;
      if (this.canvas.width !== Math.round(rect.width * dpr) || this.canvas.height !== Math.round(rect.height * dpr)) { this.canvas.width = Math.round(rect.width * dpr); this.canvas.height = Math.round(rect.height * dpr); }
      const ctx = this.context, w = rect.width, h = rect.height, left = w < 550 ? 44 : 58, right = 20, top = 25, bottom = 34;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, w, h);
      const jobs = this.plotJobs;
      $('chart-empty').hidden = jobs.length > 0;
      const maxX = Math.max(1_000_000, ...jobs.map(job => job.attempts || 0));
      const maxY = this.scaleY;
      const px = value => left + value / maxX * (w - left - right), py = value => h - bottom - value / maxY * (h - top - bottom);
      ctx.font = '9px "Segoe UI", Arial'; ctx.lineWidth = 1;
      for (let i = 0; i <= 4; i++) {
        const y = top + (h - top - bottom) * i / 4;
        ctx.strokeStyle = '#27364c80'; ctx.setLineDash([3, 5]); ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(w - right, y); ctx.stroke();
        ctx.fillStyle = '#5d7599'; ctx.textAlign = 'right';
        ctx.fillText(jobs.length ? seconds(maxY * (1 - i / 4)) : i === 4 ? '0 s' : '—', left - 9, y + 3);
      }
      ctx.setLineDash([]);
      for (let i = 0; i <= 5; i++) { const x = px(maxX * i / 5); ctx.fillStyle = '#5d7599'; ctx.textAlign = 'center'; ctx.fillText(i === 5 ? '1M' : i === 0 ? '0' : `${i * 200}k`, x, h - 11); }
      this.points = [];
      for (const job of jobs) {
        const samples = job.points;
        if (samples.length < 2) continue;
        const color = colors[job.engine];
        ctx.save(); ctx.beginPath(); ctx.rect(left, top - 5, w - left - right, h - top - bottom + 10); ctx.clip();
        const path = new Path2D(); samples.forEach((point, index) => { const x = px(point.attempts), y = py(point.elapsed); index ? path.lineTo(x, y) : path.moveTo(x, y); this.points.push({ x, y, sample: point.sample, job }); });
        const fill = new Path2D(path), last = samples.at(-1); fill.lineTo(px(last.attempts), py(0)); fill.lineTo(px(samples[0].attempts), py(0)); fill.closePath();
        const gradient = ctx.createLinearGradient(0, top, 0, h - bottom); gradient.addColorStop(0, color + '23'); gradient.addColorStop(1, color + '00'); ctx.fillStyle = gradient; ctx.fill(fill);
        ctx.strokeStyle = color; ctx.lineWidth = 1.6; ctx.shadowColor = color + '66'; ctx.shadowBlur = 8; ctx.lineJoin = 'round'; ctx.stroke(path); ctx.shadowBlur = 0;
        ctx.beginPath(); ctx.arc(px(last.attempts), py(last.elapsed), 3, 0, Math.PI * 2); ctx.fillStyle = color; ctx.fill(); ctx.restore();
      }
      const tooltip = $('chart-tooltip');
      if (this.hover) this.hover = this.points.find(point => point.job.id === this.hover.job.id && point.sample.attempts === this.hover.sample.attempts && point.sample.elapsed === this.hover.sample.elapsed) || null;
      if (this.hover) {
        const { x, y, sample, job } = this.hover;
        ctx.strokeStyle = '#8aa8d566'; ctx.setLineDash([3, 4]); ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, h - bottom); ctx.stroke(); ctx.setLineDash([]);
        tooltip.hidden = false; tooltip.textContent = `${names[job.algorithm]} · ${engineNames[job.engine]}\n${number(sample.attempts)} tentativas · ${seconds(sample.elapsed)}`;
        const size = tooltip.getBoundingClientRect();
        tooltip.style.left = `${Math.max(5, Math.min(w - size.width - 5, x + 12))}px`;
        tooltip.style.top = `${Math.max(5, Math.min(h - size.height - 5, y - size.height - 10))}px`;
      } else tooltip.hidden = true;
    }
  }
  const chart = new PerformanceChart($('performance-chart'));
  renderEngines(); controls(); health();
  setInterval(health, 2500);
})();
