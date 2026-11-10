import { onWidthChange } from './on-width-change.js';

const MAX_ROTATION = 1;
const ROTATION_EASE = 0.35;
const FRICTION = 0.95;
const MAX_VERTICAL_OFFSET = 10;

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
      if (Math.abs(velocity) > 0.02) {
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
      return;
    }
    frame = requestAnimationFrame(tick);
  };

  const run = () => {
    if (!frame) frame = requestAnimationFrame(tick);
  };

  carousel.addEventListener('pointerdown', (event) => {
    dragging = true;
    pointerId = event.pointerId;
    carousel.classList.add('dragging');
    startX = lastX = event.clientX;
    startPosition = position;
    lastTime = performance.now();
    velocity = 0;
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

  onWidthChange(reset);
  document.fonts?.ready.then(reset);
  reset();
}
