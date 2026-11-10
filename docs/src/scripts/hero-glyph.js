export function startHeroGlyph() {
  const dot = document.querySelector('#heroGlyph .lp-glyph-dot');
  if (!dot || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  dot.addEventListener('animationend', () => dot.classList.remove('nod-bounce'));
  setInterval(() => dot.classList.add('nod-bounce'), 3600);
}
