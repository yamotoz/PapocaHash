/* A fila contém apenas amostras recebidas da API; nunca inventa candidatos. */
window.CandidateStream = class {
  constructor() {
    this.root = document.getElementById('candidate-stream');
    this.home = this.root.parentElement;
    this.word = document.getElementById('stream-word');
    this.hash = document.getElementById('stream-hash');
    this.hashLabel = document.getElementById('stream-hash-label');
    this.status = document.getElementById('stream-status');
    this.info = this.root.querySelector('.info');
    this.explanation = this.info.dataset.tip;
    this.announcement = document.getElementById('stream-announcement');
    this.log = document.getElementById('stream-log');
    this.reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.number = value => new Intl.NumberFormat('pt-BR').format(value);
    this.reset();
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && this.root.dataset.status === 'running') this.schedule();
    });
  }
  reset() {
    cancelAnimationFrame(this.frame);
    this.frame = null; this.jobId = null; this.queue = [];
    this.seen = new Map(); this.lastSeq = 0; this.lastTick = 0; this.last = null;
    this.log.replaceChildren();
    this.root.dataset.status = 'idle';
    this.root.hidden = true;
    this.status.textContent = 'EM ESPERA';
    this.word.textContent = '—';
    this.hash.textContent = '—';
    this.hash.title = '';
    this.label = ''; this.summary = ''; this.trace = '';
    this.announcement.textContent = '';
  }
  details() { this.info.dataset.tip = [this.explanation, this.label, this.trace, this.summary].filter(Boolean).join(' '); }
  addLog(candidate, found = false) {
    if (!this.root.classList.contains('ranked')) return;
    const row = document.createElement('div');
    row.className = `stream-log-row${found ? ' found' : ''}`;
    row.append(
      Object.assign(document.createElement('span'), { className: 'stream-log-position', textContent: `#${this.number(candidate.position)}` }),
      Object.assign(document.createElement('span'), { className: 'stream-log-word', textContent: candidate.word }),
      Object.assign(document.createElement('code'), { className: 'stream-log-hash', textContent: candidate.hash || this.target || '—', title: candidate.hash || this.target || '' })
    );
    this.log.prepend(row);
    while (this.log.children.length > 6) this.log.lastElementChild.remove();
  }
  paint(candidate, found = false) {
    this.word.textContent = candidate.word;
    const hash = candidate.hash || (found ? this.target : '');
    this.hash.textContent = hash ? `${hash.slice(0, 18)}…${hash.slice(-10)}` : '—';
    this.hash.title = hash;
    this.trace = found ? `Correspondência confirmada · posição ${this.number(candidate.position)}` : `Trabalhador ${candidate.worker} · posição ${this.number(candidate.position)}`;
    this.details();
    this.last = candidate;
    this.addLog(candidate, found);
  }
  schedule() {
    if (this.frame || document.hidden || !this.queue.length || this.root.dataset.status !== 'running') return;
    this.frame = requestAnimationFrame(time => {
      this.frame = null;
      const pace = Math.max(16, Math.min(42, 210 / this.queue.length));
      if (time - this.lastTick >= pace) {
        this.paint(this.queue.shift());
        this.lastTick = time;
      }
      this.schedule();
    });
  }
  pause(message = 'Reconectando ao servidor…') {
    cancelAnimationFrame(this.frame); this.frame = null;
    this.root.dataset.status = 'paused';
    this.status.textContent = 'PAUSADO';
    this.trace = message; this.details();
  }
  update(job, label) {
    if (this.jobId !== job.id) { this.reset(); this.jobId = job.id; }
    this.root.hidden = false;
    this.label = label; this.target = job.target;
    this.hashLabel.textContent = job.device === 'gpu' ? 'HASH ALVO' : 'HASH TESTADO';
    this.summary = `${this.number(job.attempts || 0)} tentativas reais.`;
    this.details();
    const live = job.status === 'running';
    this.root.dataset.status = job.status;
    for (const candidate of job.preview_candidates || []) {
      if (Number.isInteger(candidate.seq)) {
        if (candidate.seq <= this.lastSeq) continue;
        this.lastSeq = candidate.seq;
      } else {
        if (this.seen.get(candidate.worker) === candidate.position) continue;
        this.seen.set(candidate.worker, candidate.position);
      }
      this.queue.push(candidate);
    }
    this.queue = this.queue.slice(-64);
    if (live) {
      this.status.textContent = 'BUSCA EM CURSO';
      if (job.device === 'gpu' && !this.queue.length) {
        this.word.textContent = 'lotes na GPU';
        this.hash.textContent = job.target ? `${job.target.slice(0, 18)}…${job.target.slice(-10)}` : '—';
        this.hash.title = job.target || '';
        this.trace = 'Hashcat processa lotes; amostras individuais de palavras não são transmitidas.';
        this.details();
        return;
      }
      if (this.reduced) {
        if (this.queue.length) this.paint(this.queue.at(-1));
        this.queue = [];
      } else {
        if (!this.last && this.queue.length) this.paint(this.queue.shift());
        this.schedule();
      }
      if (!this.last) { this.trace = 'Aguardando a primeira amostra do motor…'; this.details(); }
      return;
    }
    cancelAnimationFrame(this.frame); this.frame = null;
    if (job.status === 'found') {
      if (this.queue.length) for (const candidate of this.queue.slice(-5)) this.addLog(candidate);
      if (this.last?.word !== job.word || this.status.textContent !== 'PALAVRA ENCONTRADA') {
        this.paint({ word: job.word, position: job.position, hash: job.target }, true);
        this.announcement.textContent = `Palavra encontrada: ${job.word}. Posição ${this.number(job.position)}.`;
      }
      this.status.textContent = 'PALAVRA ENCONTRADA';
    } else if (['queued', 'preparing'].includes(job.status)) {
      this.status.textContent = job.status === 'queued' ? 'NA FILA' : 'PREPARANDO';
      this.trace = 'O motor está preparando os trabalhadores…'; this.details();
    } else {
      if (this.queue.length) {
        for (const candidate of this.queue.slice(-5, -1)) this.addLog(candidate);
        this.paint(this.queue.at(-1));
      }
      this.status.textContent = ({ timeout: 'TEMPO LIMITE', cancelled: 'INTERROMPIDA', exhausted: 'LISTA ESGOTADA', error: 'ERRO' })[job.status] || 'ENCERRADA';
      this.trace = 'Busca encerrada. Os resultados permanecem no observatório.'; this.details();
    }
    this.queue = [];
  }
};
