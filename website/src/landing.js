import { initShared, reducedMotion, revealOnScroll } from './shared.js';

// Real `cb-trainer slice` output on node-express-realworld (shortened)
const TERMINAL = [
  { cmd: 'cb-trainer slice "article comments"' },
  { out: '🧩 Feature slice: "article comments" (16 files, ~5,334 / 6,000 tokens)', cls: 't-head' },
  { out: '' },
  { out: '[server]', cls: 't-layer' },
  { out: '  src/app/routes/article/article.controller.ts  — search match' },
  { out: '  src/app/routes/article/article.service.ts     — search match' },
  { out: '  src/app/routes/article/comment.model.ts       — search match' },
  { out: '  src/app/routes/profile/profile.utils.ts       — favoriteArticle uses profileMapper' },
  { out: '[data]', cls: 't-layer' },
  { out: '  src/prisma/schema.prisma                      — search match' },
  { out: '' },
  { out: 'Flows:', cls: 't-layer' },
  { out: '  routes.ts → articlesController → addComment → HttpException', cls: 't-flow' }
];

function typeTerminal() {
  const code = document.getElementById('terminalCode');
  if (!code || code.dataset.done) return;
  code.dataset.done = '1';
  const lines = TERMINAL.map(l => l.cmd ? { text: `$ ${l.cmd}`, cls: 't-cmd', typed: true } : { text: l.out, cls: l.cls ?? '' });
  if (reducedMotion) {
    code.innerHTML = lines.map(l => `<span class="${l.cls}">${escape(l.text)}</span>`).join('\n');
    return;
  }
  let line = 0;
  const next = () => {
    if (line >= lines.length) return;
    const { text, cls, typed } = lines[line++];
    const span = document.createElement('span');
    span.className = cls;
    code.append(span, line < lines.length ? '\n' : '');
    if (!typed) {
      span.textContent = text;
      setTimeout(next, 70);
      return;
    }
    let i = 0;
    const type = () => {
      span.textContent = text.slice(0, ++i);
      if (i < text.length) setTimeout(type, 28 + Math.random() * 40);
      else setTimeout(next, 420);
    };
    type();
  };
  next();
}

const escape = s => s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);

function countUp(el) {
  const target = Number(el.dataset.count);
  const decimals = Number(el.dataset.decimals ?? 0);
  const suffix = el.dataset.suffix ?? '';
  const format = v => `${v.toFixed(decimals)}${suffix}`;
  if (reducedMotion) {
    el.textContent = format(target);
    return;
  }
  const start = performance.now();
  const duration = 1400;
  const step = now => {
    const t = Math.min(1, (now - start) / duration);
    const eased = 1 - Math.pow(1 - t, 3);
    el.textContent = format(target * eased);
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// Scroll parallax for [data-parallax] layers, and mouse parallax for the hero chips
function parallax() {
  if (reducedMotion) return;
  const layers = [...document.querySelectorAll('[data-parallax]')];
  const chips = [...document.querySelectorAll('.chip[data-depth]')];
  const progress = document.getElementById('scrollProgress');
  let mx = 0, my = 0, ticking = false;

  const render = () => {
    ticking = false;
    const y = window.scrollY;
    layers.forEach(layer => {
      layer.style.transform = `translate3d(0, ${y * Number(layer.dataset.parallax)}px, 0)`;
    });
    chips.forEach(chip => {
      const depth = Number(chip.dataset.depth);
      chip.style.setProperty('--px', `${mx * depth}px`);
      chip.style.setProperty('--py', `${my * depth}px`);
    });
    if (progress) {
      const max = document.documentElement.scrollHeight - window.innerHeight;
      progress.style.transform = `scaleX(${max > 0 ? y / max : 0})`;
    }
  };
  const request = () => {
    if (!ticking) {
      ticking = true;
      requestAnimationFrame(render);
    }
  };
  window.addEventListener('scroll', request, { passive: true });
  window.addEventListener('pointermove', event => {
    mx = event.clientX / window.innerWidth - 0.5;
    my = event.clientY / window.innerHeight - 0.5;
    request();
  }, { passive: true });
  render();
}

// Cards lean towards the pointer
function tilt() {
  if (reducedMotion || !window.matchMedia('(pointer: fine)').matches) return;
  document.querySelectorAll('.tilt').forEach(card => {
    card.addEventListener('pointermove', event => {
      const r = card.getBoundingClientRect();
      const x = (event.clientX - r.left) / r.width - 0.5;
      const y = (event.clientY - r.top) / r.height - 0.5;
      card.style.setProperty('--rx', `${-y * 8}deg`);
      card.style.setProperty('--ry', `${x * 10}deg`);
      card.style.setProperty('--gx', `${(x + 0.5) * 100}%`);
      card.style.setProperty('--gy', `${(y + 0.5) * 100}%`);
    });
    card.addEventListener('pointerleave', () => {
      card.style.setProperty('--rx', '0deg');
      card.style.setProperty('--ry', '0deg');
    });
  });
}

document.addEventListener('DOMContentLoaded', () => {
  initShared();
  parallax();
  tilt();
  revealOnScroll('[data-reveal]', el => {
    el.querySelectorAll('[data-count]').forEach(countUp);
    if (el.matches('[data-count]')) countUp(el);
    el.querySelectorAll('[data-bar]').forEach(bar => { bar.style.setProperty('--w', `${bar.dataset.bar}%`); });
    if (el.id === 'terminal') typeTerminal();
  });
});
