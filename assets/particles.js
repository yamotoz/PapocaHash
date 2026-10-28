/* Emblema local em canvas: partículas retornam à forma do cadeado após o hover. */
(() => {
  const canvas = document.getElementById('particle-lock');
  const context = canvas?.getContext('2d', { alpha: true });
  if (!context) return;

  const host = canvas.parentElement;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const width = 200, height = 180;
  const particles = [], paths = [];
  const colors = { body: '#a8ceff', shackle: '#d6e7ff', hash: '#b6f8dc', orbit: '#94b8e5' };
  const noise = value => {
    const result = Math.sin(value * 127.1 + 78.233) * 43758.5453;
    return result - Math.floor(result);
  };

  function point(x, y, layer, path) {
    const index = particles.length;
    const particle = {
      x0: x, y0: y, x: x + (noise(index + 2) - .5) * 8,
      y: y + (noise(index + 91) - .5) * 8,
      layer, phase: noise(index + 33) * Math.PI * 2,
      size: .65 + noise(index + 54) * 1.05
    };
    particles.push(particle);
    path?.push(particle);
  }
  function line(path, x1, y1, x2, y2, layer, spacing = 4) {
    const count = Math.max(2, Math.ceil(Math.hypot(x2 - x1, y2 - y1) / spacing));
    for (let index = 0; index < count; index++) {
      const t = index / count;
      point(x1 + (x2 - x1) * t, y1 + (y2 - y1) * t, layer, path);
    }
  }
  function arc(path, cx, cy, radius, start, end, layer) {
    const count = Math.ceil(Math.abs(end - start) * radius / 4);
    for (let index = 0; index < count; index++) {
      const angle = start + (end - start) * index / count;
      point(cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius, layer, path);
    }
  }
  function path(layer, build) {
    const points = [];
    build(points, layer);
    paths.push({ points, layer });
  }

  path('body', (p, layer) => {
    line(p, 58, 78, 142, 78, layer);
    arc(p, 142, 89, 11, -Math.PI / 2, 0, layer);
    line(p, 153, 89, 153, 140, layer);
    arc(p, 142, 140, 11, 0, Math.PI / 2, layer);
    line(p, 142, 151, 58, 151, layer);
    arc(p, 58, 140, 11, Math.PI / 2, Math.PI, layer);
    line(p, 47, 140, 47, 89, layer);
    arc(p, 58, 89, 11, Math.PI, Math.PI * 1.5, layer);
  });
  path('shackle', (p, layer) => {
    line(p, 63, 80, 63, 73, layer);
    arc(p, 100, 73, 37, Math.PI, Math.PI * 2, layer);
    line(p, 137, 73, 137, 80, layer);
  });
  path('shackle', (p, layer) => {
    line(p, 74, 80, 74, 73, layer);
    arc(p, 100, 73, 26, Math.PI, Math.PI * 2, layer);
    line(p, 126, 73, 126, 80, layer);
  });
  for (const [x1, y1, x2, y2] of [
    [91, 95, 85, 134], [115, 95, 109, 134],
    [77, 109, 124, 109], [75, 122, 122, 122]
  ]) path('hash', (p, layer) => line(p, x1, y1, x2, y2, layer, 3.4));
  for (let index = 0; index < 44; index++) {
    const angle = index * 2.39996;
    const radius = 63 + noise(index + 150) * 32;
    const orbit = {
      x0: 100 + Math.cos(angle) * radius,
      y0: 91 + Math.sin(angle) * radius * .82,
      x: 100 + Math.cos(angle) * radius,
      y: 91 + Math.sin(angle) * radius * .82,
      angle, radius, layer: 'orbit', phase: angle,
      size: .45 + noise(index + 210) * .65
    };
    particles.push(orbit);
  }

  let frame = 0, visible = true, inside = false, hover = 0;
  let pointer = { x: 100, y: 90 };
  let scaleX = 1, scaleY = 1;
  function resize() {
    const rect = host.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const pixelRatio = Math.min(devicePixelRatio || 1, 2);
    canvas.width = Math.round(rect.width * pixelRatio);
    canvas.height = Math.round(rect.height * pixelRatio);
    scaleX = canvas.width / width;
    scaleY = canvas.height / height;
    draw(0);
  }
  function draw(timestamp) {
    if (!canvas.width || !canvas.height) return;
    const time = timestamp / 1000;
    hover += ((inside && !reduced.matches ? 1 : 0) - hover) * .09;
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.setTransform(scaleX, 0, 0, scaleY, 0, 0);
    const halo = context.createRadialGradient(100, 98, 4, 100, 98, 91);
    halo.addColorStop(0, `rgba(82, 143, 215, ${.16 + hover * .13})`);
    halo.addColorStop(1, 'rgba(68, 122, 192, 0)');
    context.fillStyle = halo;
    context.fillRect(0, 0, width, height);

    for (const particle of particles) {
      let targetX = particle.x0, targetY = particle.y0;
      if (particle.layer === 'orbit') {
        const angle = particle.angle + time * (.11 + particle.size * .04);
        targetX = 100 + Math.cos(angle) * particle.radius;
        targetY = 91 + Math.sin(angle) * particle.radius * .82;
      } else {
        targetX += Math.sin(time * 1.15 + particle.phase) * .8;
        targetY += Math.cos(time * 1.1 + particle.phase) * .8;
        if (particle.layer === 'shackle') { targetX += hover * 7; targetY -= hover * 10; }
        const dx = targetX - pointer.x, dy = targetY - pointer.y;
        const distance = Math.max(1, Math.hypot(dx, dy));
        const force = Math.max(0, 1 - distance / 77) ** 2 * hover;
        targetX += (dx / distance * 35 - dy / distance * 15) * force;
        targetY += (dy / distance * 35 + dx / distance * 15) * force;
      }
      const follow = reduced.matches ? 1 : particle.layer === 'orbit' ? .045 : .105;
      particle.x += (targetX - particle.x) * follow;
      particle.y += (targetY - particle.y) * follow;
    }

    context.lineWidth = .85;
    for (const path of paths) {
      context.beginPath();
      path.points.forEach((particle, index) => index ? context.lineTo(particle.x, particle.y) : context.moveTo(particle.x, particle.y));
      context.strokeStyle = path.layer === 'hash' ? `rgba(168, 245, 213, ${.23 + hover * .12})` : `rgba(168, 207, 255, ${.19 + hover * .12})`;
      context.stroke();
    }
    context.globalCompositeOperation = 'lighter';
    particles.forEach((particle, index) => {
      const flicker = reduced.matches ? 1 : .76 + Math.sin(time * 2.8 + particle.phase) * .2;
      context.globalAlpha = (particle.layer === 'orbit' ? .34 : .72 + hover * .17) * flicker;
      context.fillStyle = colors[particle.layer];
      context.beginPath();
      context.arc(particle.x, particle.y, particle.size * (particle.layer === 'hash' ? 1.28 : 1.15), 0, Math.PI * 2);
      context.fill();
      if (index % 11 === 0 && particle.layer !== 'orbit') {
        context.globalAlpha = .14 + hover * .11;
        context.beginPath();
        context.arc(particle.x, particle.y, 5 + hover * 2, 0, Math.PI * 2);
        context.fill();
      }
    });
    context.globalAlpha = 1;
    context.globalCompositeOperation = 'source-over';
    host.classList.add('is-ready');
  }
  function animate(timestamp) {
    frame = 0;
    if (!visible || document.hidden) return;
    draw(timestamp);
    if (!reduced.matches) frame = requestAnimationFrame(animate);
  }
  function start() {
    if (frame || !visible || document.hidden) return;
    if (reduced.matches) draw(0);
    else frame = requestAnimationFrame(animate);
  }
  function stop() { cancelAnimationFrame(frame); frame = 0; }
  host.addEventListener('pointerenter', () => { inside = true; start(); });
  host.addEventListener('pointermove', event => {
    const rect = host.getBoundingClientRect();
    pointer = { x: (event.clientX - rect.left) / rect.width * width, y: (event.clientY - rect.top) / rect.height * height };
    inside = true;
  });
  host.addEventListener('pointerleave', () => { inside = false; });
  document.addEventListener('visibilitychange', () => document.hidden ? stop() : start());
  reduced.addEventListener?.('change', () => { stop(); start(); });
  if ('IntersectionObserver' in window) new IntersectionObserver(entries => {
    visible = entries[0].isIntersecting;
    if (visible) start(); else stop();
  }, { threshold: .05 }).observe(host);
  if ('ResizeObserver' in window) new ResizeObserver(resize).observe(host);
  else addEventListener('resize', resize);
  resize();
  start();
})();
