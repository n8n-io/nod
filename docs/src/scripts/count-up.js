const DURATION = 1500;

const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

function format(number, value) {
  const { prefix = '', suffix = '', decimals = '0' } = number.dataset;
  return prefix + value.toFixed(Number(decimals)) + suffix;
}

function animate(number) {
  const target = Number(number.dataset.countTo);
  const start = performance.now();
  const tick = (now) => {
    const progress = Math.min(1, (now - start) / DURATION);
    number.textContent = format(number, target * ease(progress));
    if (progress < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

export function startCountUp() {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  for (const group of document.querySelectorAll('[data-count-up-group]')) {
    const numbers = Array.from(group.querySelectorAll('[data-count-to]'));
    for (const number of numbers) number.textContent = format(number, 0);
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        observer.disconnect();
        numbers.forEach(animate);
      },
      { threshold: 0.4 },
    );
    observer.observe(group);
  }
}
