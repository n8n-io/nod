function story(screen) {
  const items = Array.from(screen.querySelectorAll('[data-at]')).map((element) => ({
    element,
    at: Number(element.dataset.at),
    until: element.dataset.until ? Number(element.dataset.until) : Infinity,
  }));
  const times = [
    ...new Set(items.flatMap((item) => [item.at, item.until]).filter(Number.isFinite)),
  ];
  let timers = [];
  const show = (time) => {
    for (const item of items) {
      item.element.classList.toggle('is-in', item.at <= time);
      item.element.classList.toggle('is-out', item.until <= time);
    }
  };
  return {
    play() {
      if (screen.dataset.story === 'play') return;
      screen.dataset.story = 'play';
      timers = times.map((time) => setTimeout(() => show(time), time));
    },
    reset() {
      for (const timer of timers) clearTimeout(timer);
      timers = [];
      screen.dataset.story = 'ready';
      show(-1);
    },
  };
}

export function startPanelStories() {
  const screens = document.querySelectorAll('.lp-stack .nod-screen');
  if (
    !screens.length ||
    !('IntersectionObserver' in window) ||
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
    return;
  const stories = new Map();
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const current = stories.get(entry.target);
        if (entry.intersectionRatio >= 0.5) current.play();
        else if (!entry.isIntersecting) current.reset();
      }
    },
    { threshold: [0, 0.5] },
  );
  for (const screen of screens) {
    const current = story(screen);
    stories.set(screen, current);
    current.reset();
    observer.observe(screen);
  }
}
