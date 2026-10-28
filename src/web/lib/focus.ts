export function initializeFocusVisibility() {
  document.addEventListener(
    'pointerdown',
    () => {
      document.documentElement.dataset.focusInput = 'pointer';
    },
    true,
  );
  document.addEventListener(
    'keydown',
    (event) => {
      if (event.key === 'Escape') {
        document.documentElement.dataset.focusInput = 'pointer';
        return;
      }
      if (['Meta', 'Control', 'Alt', 'Shift'].includes(event.key)) return;
      document.documentElement.dataset.focusInput = 'keyboard';
    },
    true,
  );
}
