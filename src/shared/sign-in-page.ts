export function signInPage(succeeded: boolean, nonce: string, provider?: 'ChatGPT' | 'OpenRouter') {
  return {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    },
    html: `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${succeeded ? 'Signed in' : 'Sign-in failed'} · Nod</title>
  <style nonce="${nonce}">
    :root { color-scheme: light dark; --background: #fdfcfe; --foreground: #211c28; --muted: #6d6273; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100svh; display: grid; place-items: center; padding: 32px 24px; background: var(--background); color: var(--foreground); font-family: Inter, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; -webkit-font-smoothing: antialiased; }
    main { width: min(100%, 400px); text-align: center; }
    .brand { display: flex; align-items: center; justify-content: center; gap: 10px; margin-bottom: 40px; font-size: 26px; font-weight: 650; letter-spacing: -1px; }
    .brand svg { width: 36px; height: 36px; }
    h1 { margin: 0 0 12px; font-size: 28px; font-weight: 600; letter-spacing: -.8px; line-height: 1.2; }
    p { margin: 0; color: var(--muted); font-size: 15px; line-height: 1.7; }
    button { margin-top: 24px; border: 0; border-radius: 999px; padding: 12px 20px; background: #ff91ac; color: #191919; font: inherit; cursor: pointer; }
    button:hover { background: #ffd0d9; }
    button:focus-visible { outline: 2px solid currentColor; outline-offset: 4px; }
    @media (prefers-color-scheme: dark) { :root { --background: #1e1b21; --foreground: #f5f1f6; --muted: #ada4b6; } }
  </style>
</head>
<body>
  <main aria-labelledby="title">
    <div class="brand"><svg viewBox="0 0 32 32" fill="none" aria-hidden="true"><circle cx="16" cy="16" r="10" stroke="currentColor" stroke-width="4"/><circle cx="25" cy="6" r="4" fill="#ff91ac"/></svg><span>Nod</span></div>
    <h1 id="title">${succeeded ? `${provider ?? 'Your model'} is connected` : 'Sign-in didn’t finish'}</h1>
    <p>${succeeded ? 'You can close this tab and return to Nod.' : 'Return to Nod and try connecting again.'}</p>
    ${succeeded ? '<button type="button" id="close">Close page</button>' : ''}
  </main>
  <script nonce="${nonce}">
    try { history.replaceState(null, '', location.pathname); } catch {}
    ${succeeded ? "document.getElementById('close').addEventListener('click', () => window.close()); window.close();" : ''}
  </script>
</body>
</html>`,
  };
}
