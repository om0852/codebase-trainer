import { initCrosshair } from './crosshair.js';

export const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export async function copyText(text, button) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    return;
  }
  const label = button.querySelector('span') ?? button;
  const before = label.textContent;
  label.textContent = 'COPIED';
  setTimeout(() => { label.textContent = before; }, 1600);
}

/** Navigation, copy buttons and the crosshair cursor, on every page. */
export function initShared() {
  // Pointer-only decoration; skipped on touch screens and for reduced motion
  if (window.matchMedia('(pointer: fine)').matches && !reducedMotion) {
    initCrosshair({
      color: '#ffffff',
      thickness: 1,
      opacity: 0.6,
      lineStyle: 'solid',
      gap: 4,
      fade: 0.15,
      smoothing: 0.35,
      showCoordinates: false,
      targetEffect: 'lock',
      targetSelector: 'a, button, .tool-nav-item, .ide-tab, .feature',
      clickPulse: true,
      hideCursor: false,
      blendMode: 'normal'
    });
  }

  document.querySelectorAll('[data-copy]').forEach(button => {
    button.addEventListener('click', () => copyText(button.getAttribute('data-copy'), button));
  });

  const navbar = document.getElementById('navbar');
  const onScroll = () => navbar?.classList.toggle('scrolled', window.scrollY > 12);
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  const toggle = document.getElementById('navToggle');
  const menu = document.getElementById('navMenu');
  if (toggle && menu) {
    const close = () => {
      menu.classList.remove('open');
      toggle.setAttribute('aria-expanded', 'false');
      toggle.textContent = 'MENU';
    };
    toggle.addEventListener('click', () => {
      const open = menu.classList.toggle('open');
      toggle.setAttribute('aria-expanded', String(open));
      toggle.textContent = open ? 'CLOSE' : 'MENU';
    });
    menu.querySelectorAll('a').forEach(link => link.addEventListener('click', close));
  }
}

/** Adds `.in` to elements as they enter the viewport (once). */
export function revealOnScroll(selector, onReveal) {
  const elements = document.querySelectorAll(selector);
  if (reducedMotion || !('IntersectionObserver' in window)) {
    elements.forEach(el => { el.classList.add('in'); onReveal?.(el); });
    return;
  }
  const observer = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      if (!entry.isIntersecting) return;
      entry.target.classList.add('in');
      onReveal?.(entry.target);
      observer.unobserve(entry.target);
    });
  }, { threshold: 0.2, rootMargin: '0px 0px -8% 0px' });
  elements.forEach(el => observer.observe(el));
}
