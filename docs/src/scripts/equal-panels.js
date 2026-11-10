import { onWidthChange } from './on-width-change.js';

export function startEqualPanels() {
  const photos = Array.from(document.querySelectorAll('.lp-stack .lp-panel-photo'));
  if (!photos.length) return;
  const equalize = () => {
    for (const photo of photos) photo.style.minHeight = '';
    const height = Math.max(...photos.map((photo) => photo.offsetHeight));
    for (const photo of photos) photo.style.minHeight = `${height}px`;
  };
  equalize();
  window.addEventListener('load', equalize);
  document.fonts?.ready.then(equalize);
  onWidthChange(equalize);
}
