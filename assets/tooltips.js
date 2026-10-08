/* Um balão na camada superior evita cortes por cards, tabelas e modais. */
(() => {
  'use strict';
  const bubble = document.getElementById('info-tooltip');
  const hasPopover = typeof bubble.showPopover === 'function';
  const visual = window.visualViewport;
  let leaveTimer;
  let anchor = null;
  const trigger = element => element?.closest?.('.info[data-tip]');
  const viewport = () => ({
    left: visual?.offsetLeft || 0, top: visual?.offsetTop || 0,
    width: visual?.width || innerWidth, height: visual?.height || innerHeight
  });

  function position() {
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect(), view = viewport(), margin = 12, gap = 10;
    if (!anchor.isConnected || rect.bottom < view.top || rect.top > view.top + view.height) return hide();
    bubble.style.maxWidth = `${Math.max(1, view.width - margin * 2)}px`;
    bubble.style.maxHeight = `${Math.max(1, view.height - margin * 2)}px`;
    const size = bubble.getBoundingClientRect();
    const below = rect.bottom + gap;
    const top = below + size.height <= view.top + view.height - margin ? below : rect.top - gap - size.height;
    const clamp = (value, min, max) => Math.max(min, Math.min(value, max));
    bubble.style.left = `${clamp(rect.left + rect.width / 2 - size.width / 2, view.left + margin, view.left + view.width - margin - size.width)}px`;
    bubble.style.top = `${clamp(top, view.top + margin, view.top + view.height - margin - size.height)}px`;
  }
  function hide() {
    clearTimeout(leaveTimer);
    if (anchor) {
      const ids = (anchor.getAttribute('aria-describedby') || '').split(/\s+/).filter(id => id && id !== bubble.id);
      if (ids.length) anchor.setAttribute('aria-describedby', ids.join(' '));
      else anchor.removeAttribute('aria-describedby');
    }
    anchor = null;
    if (hasPopover && bubble.matches(':popover-open')) bubble.hidePopover();
    bubble.hidden = true;
  }
  function show(element) {
    clearTimeout(leaveTimer);
    if (anchor !== element) hide();
    anchor = element;
    bubble.textContent = element.dataset.tip;
    const ids = new Set((element.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean));
    ids.add(bubble.id);
    element.setAttribute('aria-describedby', [...ids].join(' '));
    const parent = element.closest('dialog[open]') || document.body;
    if (bubble.parentElement !== parent) parent.append(bubble);
    bubble.hidden = false;
    // Popovers ficam acima do dialog. O fallback acompanha o modal aberto.
    if (hasPopover) {
      if (!bubble.matches(':popover-open')) bubble.showPopover();
    }
    position();
  }
  document.addEventListener('pointerover', event => {
    if (bubble.contains(event.target)) clearTimeout(leaveTimer);
    const element = trigger(event.target);
    if (element) show(element);
  });
  document.addEventListener('pointerout', event => {
    if (!anchor || event.pointerType === 'touch') return;
    if (anchor.contains(event.relatedTarget) || bubble.contains(event.relatedTarget)) return;
    if (trigger(event.target) === anchor && document.activeElement !== anchor) leaveTimer = setTimeout(hide, 150);
    if (bubble.contains(event.target) && !bubble.contains(event.relatedTarget)) leaveTimer = setTimeout(hide, 150);
  });
  document.addEventListener('focusin', event => {
    const element = trigger(event.target) || event.target.closest?.('.algorithm-card')?.querySelector('.info');
    if (element) show(element);
  });
  document.addEventListener('focusout', event => {
    if (trigger(event.relatedTarget)) return;
    hide();
  });
  // Captura impede que tocar no i selecione um motor ou abra o card.
  document.addEventListener('click', event => {
    const element = trigger(event.target);
    if (element) { event.preventDefault(); event.stopPropagation(); show(element); }
    else if (!bubble.contains(event.target)) hide();
  }, true);
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && anchor) { hide(); event.preventDefault(); event.stopPropagation(); }
  }, true);
  document.addEventListener('close', hide, true);
  document.addEventListener('scroll', position, true);
  addEventListener('resize', position);
  visual?.addEventListener('resize', position);
  visual?.addEventListener('scroll', position);
})();
