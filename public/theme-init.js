(() => {
  let theme;
  try {
    theme = localStorage.getItem('nod.theme');
  } catch {}
  if (theme !== 'light' && theme !== 'dark')
    theme = window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', theme === 'dark' ? '#1e1b21' : '#fdfcfe');
})();
