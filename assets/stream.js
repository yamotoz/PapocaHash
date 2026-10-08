/* A fila contém apenas amostras recebidas da API; nunca inventa candidatos. */
window.CandidateStream = class {
  constructor() {
    this.root = document.getElementById('candidate-stream');
    this.word = document.getElementById('stream-word');
    this.status = document.getElementById('stream-status');
    this.info = this.root.querySelector('.info');
    this.explanation = this.info.dataset.tip;
    this.announcement = document.getElementById('stream-announcement');
    this.reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.number = value => new Intl.NumberFormat('pt-BR').format(value);
    this.reset();
  }
  reset() {
    clearInterval(this.timer);
    this.motion?.cancel();
    this.timer = null; this.jobId = null; this.queue = []; this.seen = new Map(); this.last = null;
    this.root.dataset.status = 'idle';
    this.root.hidden = true;
    this.status.textContent = 'EM ESPERA';
    this.word.textContent = '—';
    this.label = ''; this.summary = ''; this.trace = '';
    this.announcement.textContent = '';
  }
  paint(candidate, found = false) {
    this.word.textContent = candidate.word;
    this.trace = found ? `Correspondência confirmada · posição ${this.number(candidate.position)}` : `Trabalhador ${candidate.worker} · posição ${this.number(candidate.position)}`;
    this.details();
    this.last = candidate;
    this.motion?.cancel();
    if (!this.reduced) this.motion = this.word.animate([
      { opacity: .3, transform: 'translateY(3px)', filter: 'blur(1px)' },
      { opacity: 1, transform: 'translateY(0)', filter: 'blur(0)' }
    ], { duration: found ? 280 : 30, easing: 'cubic-bezier(.2,.7,.2,1)' });
  }
  details() { this.info.dataset.tip = [this.explanation, this.label, this.trace, this.summary].filter(Boolean).join(' '); }
  tick() {
    if (document.hidden || !this.queue.length) return;
    this.paint(this.queue.shift());
  }
  pause(message = 'Reconectando ao servidor…') {
    clearInterval(this.timer); this.timer = null;
    this.root.dataset.status = 'paused';
    this.status.textContent = 'PAUSADO';
    this.trace = message; this.details();
  }
  update(job, label) {
    if (this.jobId !== job.id) { this.reset(); this.jobId = job.id; }
    this.root.hidden = false;
    this.label = label;
    this.summary = `${this.number(job.attempts || 0)} tentativas reais.`;
    this.details();
    const live = job.status === 'running';
    this.root.dataset.status = job.status;
    for (const candidate of job.preview_candidates || []) {
      if (this.seen.get(candidate.worker) === candidate.position) continue;
      this.seen.set(candidate.worker, candidate.position);
      this.queue.push(candidate);
    }
    this.queue = this.queue.slice(-48);
    if (live) {
      this.status.textContent = 'BUSCA EM CURSO';
      if (job.device === 'gpu' && !this.queue.length) {
        this.word.textContent = 'lotes na GPU';
        this.trace = 'Hashcat processa lotes; amostras individuais de palavras não são transmitidas.';
        this.details();
        return;
      }
      if (!this.last) this.tick();
      if (this.reduced) { if (this.queue.length) this.paint(this.queue.at(-1)); this.queue = []; }
      else if (!this.timer) this.timer = setInterval(() => this.tick(), 24);
      if (!this.last) { this.trace = 'Aguardando a primeira amostra do motor…'; this.details(); }
      return;
    }
    clearInterval(this.timer); this.timer = null;
    if (job.status === 'found') {
      if (this.last?.word !== job.word || this.status.textContent !== 'PALAVRA ENCONTRADA') {
        if (!this.last && this.queue.length) this.last = this.queue.at(-1);
        this.paint({ word: job.word, position: job.position }, true);
        this.announcement.textContent = `Palavra encontrada: ${job.word}. Posição ${this.number(job.position)}.`;
      }
      this.status.textContent = 'PALAVRA ENCONTRADA';
    } else if (['queued', 'preparing'].includes(job.status)) {
      this.status.textContent = job.status === 'queued' ? 'NA FILA' : 'PREPARANDO';
      this.trace = 'O motor está preparando os trabalhadores…'; this.details();
    } else {
      if (this.queue.length) this.paint(this.queue.at(-1));
      this.status.textContent = ({ timeout: 'TEMPO LIMITE', cancelled: 'INTERROMPIDA', exhausted: 'LISTA ESGOTADA', error: 'ERRO' })[job.status] || 'ENCERRADA';
      this.trace = 'Busca encerrada. Os resultados permanecem no observatório.'; this.details();
    }
    this.queue = [];
  }
};
