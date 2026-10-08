/* Realce local, sem dependências; o texto copiado preserva o código original. */
(() => {
  const pattern = /(#.*$|\/\/.*$|b?'(?:\\.|[^'\\])*'|\b(?:def|for|in|if|return|None|else|or|is|pub|fn|bool|usize)\b|\b(?:iterative|recursive|enumerate|len|find|FnMut|Option|split|filter|is_empty|position)\b|\b\d+\b)/g;
  for (const code of document.querySelectorAll('.code-window code')) {
    const lines = code.textContent.split('\n');
    code.replaceChildren(...lines.map(line => {
      const row = Object.assign(document.createElement('span'), { className: 'code-line' });
      const pieces = line.split(pattern);
      pieces.forEach((piece, index) => {
        if (index % 2 === 0) row.append(document.createTextNode(piece));
        else {
          const type = /^(#|\/\/)/.test(piece) ? 'comment' : /^b?'/.test(piece) ? 'string' : /^\d/.test(piece) ? 'number' : /^(iterative|recursive|enumerate|len|find|FnMut|Option|split|filter|is_empty|position)$/.test(piece) ? 'function' : 'keyword';
          row.append(Object.assign(document.createElement('span'), { className: `syntax-${type}`, textContent: piece }));
        }
      });
      row.append(document.createTextNode('\n'));
      return row;
    }));
  }
  document.querySelectorAll('[data-copy-code]').forEach(button => button.addEventListener('click', async () => {
    const code = document.getElementById(button.dataset.copyCode), original = button.textContent;
    try { await navigator.clipboard.writeText(code.textContent.trimEnd()); button.textContent = 'Copiado ✓'; }
    catch {
      const range = document.createRange(); range.selectNodeContents(code);
      getSelection().removeAllRanges(); getSelection().addRange(range);
      button.textContent = 'Selecionado · Ctrl+C';
    }
    setTimeout(() => { button.textContent = original; }, 2500);
  }));
  if (!matchMedia('(prefers-reduced-motion: reduce)').matches && 'IntersectionObserver' in window) {
    const observer = new IntersectionObserver(entries => entries.forEach(entry => {
      if (entry.isIntersecting) { entry.target.dataset.reveal = 'visible'; observer.unobserve(entry.target); }
    }), { threshold: .08, rootMargin: '0px 0px 30px 0px' });
    document.querySelectorAll('.code-card').forEach(card => { card.dataset.reveal = 'pending'; observer.observe(card); });
  }
})();
