import { onWidthChange } from './on-width-change.js';

const MAX_ROTATION = 1;
const ROTATION_EASE = 0.35;
const FRICTION = 0.95;
const MAX_VERTICAL_OFFSET = 10;
const MIN_SPEED = 0.02;
const AUTO_DELAY = 3000;

export function startCarousel() {
  const carousel = document.getElementById('hardOnesCarousel');
  const track = document.getElementById('hardOnesTrack');
  if (!carousel || !track) return;

  const originals = Array.from(track.children);
  for (let copy = 0; copy < 2; copy++) {
    for (const card of originals) {
      const clone = card.cloneNode(true);
      clone.setAttribute('aria-hidden', 'true');
      track.appendChild(clone);
    }
  }
  const cards = Array.from(track.children);
  const offsets = originals.map(() => (Math.random() * 2 - 1) * MAX_VERTICAL_OFFSET);

  let setWidth = 0;
  let position = 0;
  let velocity = 0;
  let rotation = 0;
  let dragging = false;
  let pointerId = null;
  let startX = 0;
  let startPosition = 0;
  let lastX = 0;
  let lastTime = 0;
  let frame = null;
  let timer = null;
  let hovering = false;
  let visible = false;
  const still = window.matchMedia('(prefers-reduced-motion: reduce)');

  const measure = () => {
    setWidth = track.scrollWidth / 3;
  };

  const centered = () => {
    const first = cards[originals.length];
    if (carousel.clientWidth < first.offsetWidth * 2.5) {
      return carousel.clientWidth / 2 - (first.offsetLeft + first.offsetWidth / 2);
    }
    const last = cards[originals.length * 2 - 1];
    return carousel.clientWidth / 2 - (first.offsetLeft + last.offsetLeft + last.offsetWidth) / 2;
  };

  const wrap = () => {
    while (position <= -2 * setWidth) position += setWidth;
    while (position > 0) position -= setWidth;
  };

  const render = () => {
    track.style.transform = `translateX(${position}px)`;
    cards.forEach((card, index) => {
      const offset = offsets[index % originals.length];
      card.style.transform = `rotate(${rotation.toFixed(3)}deg) translateY(${offset.toFixed(2)}px)`;
    });
  };

  const reset = () => {
    measure();
    if (dragging) return;
    position = centered();
    render();
  };

  const tick = () => {
    if (!dragging) {
      velocity *= FRICTION;
      if (Math.abs(velocity) > MIN_SPEED) {
        position += velocity * 16;
        wrap();
      } else {
        velocity = 0;
      }
    }
    const target = Math.max(-MAX_ROTATION, Math.min(MAX_ROTATION, velocity));
    rotation += (target - rotation) * ROTATION_EASE;
    render();
    if (!dragging && velocity === 0 && Math.abs(rotation) < 0.01) {
      rotation = 0;
      render();
      frame = null;
      schedule();
      return;
    }
    frame = requestAnimationFrame(tick);
  };

  const run = () => {
    if (!frame) frame = requestAnimationFrame(tick);
  };

  const advance = () => {
    if (dragging || hovering || !visible || document.hidden || still.matches) return;
    const step = cards[1].offsetLeft - cards[0].offsetLeft;
    velocity = -((step * (1 - FRICTION)) / 16 + MIN_SPEED) / FRICTION;
    run();
  };

  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(advance, AUTO_DELAY);
  };

  carousel.addEventListener('pointerdown', (event) => {
    dragging = true;
    pointerId = event.pointerId;
    carousel.classList.add('dragging');
    startX = lastX = event.clientX;
    startPosition = position;
    lastTime = performance.now();
    velocity = 0;
    clearTimeout(timer);
    carousel.setPointerCapture(event.pointerId);
    run();
  });

  window.addEventListener('pointermove', (event) => {
    if (!dragging || event.pointerId !== pointerId) return;
    const now = performance.now();
    if (now > lastTime) velocity = (event.clientX - lastX) / (now - lastTime);
    position = startPosition + (event.clientX - startX);
    wrap();
    lastX = event.clientX;
    lastTime = now;
  });

  const end = (event) => {
    if (!dragging || event.pointerId !== pointerId) return;
    dragging = false;
    pointerId = null;
    carousel.classList.remove('dragging');
    run();
  };
  window.addEventListener('pointerup', end);
  window.addEventListener('pointercancel', end);

  carousel.addEventListener('pointerenter', (event) => {
    if (event.pointerType === 'mouse') hovering = true;
  });
  carousel.addEventListener('pointerleave', (event) => {
    if (event.pointerType !== 'mouse') return;
    hovering = false;
    schedule();
  });
  document.addEventListener('visibilitychange', schedule);
  new IntersectionObserver((entries) => {
    visible = entries.some((entry) => entry.isIntersecting);
    if (visible) schedule();
  }).observe(carousel);

  onWidthChange(reset);
  document.fonts?.ready.then(reset);
  reset();
}
