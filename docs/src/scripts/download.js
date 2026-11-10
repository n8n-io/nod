const installers = {
  'darwin-arm64': { path: 'mac', label: 'Download for Mac' },
  'darwin-x64': { path: 'mac-intel', label: 'Download for Mac' },
  'win32-x64': { path: 'windows', label: 'Download for Windows' },
  mobile: { href: '/docs/get-started/install-desktop/', label: 'Install on your computer' },
};

async function detectPlatform(nav) {
  const agent = nav.userAgent || '';
  if (
    /iPhone|iPad|iPod|Android/i.test(agent) ||
    (/Macintosh/.test(agent) && nav.maxTouchPoints > 1)
  )
    return 'mobile';
  const hints = nav.userAgentData;
  const platform = hints?.platform || nav.platform || agent;
  let architecture = '';
  try {
    architecture = (await hints?.getHighEntropyValues?.(['architecture']))?.architecture || '';
  } catch {}
  if (/mac/i.test(platform)) return architecture === 'x86' ? 'darwin-x64' : 'darwin-arm64';
  if (/win/i.test(platform)) return architecture === 'arm' ? null : 'win32-x64';
  return null;
}

export function startDownload() {
  const links = document.querySelectorAll('[data-download]');
  detectPlatform(navigator).then((platform) => {
    const installer = installers[platform];
    if (!installer) return;
    for (const link of links) {
      link.href = installer.href ?? link.href.replace(/[^/]+$/, installer.path);
      if (link.dataset.download === 'label') link.textContent = installer.label;
    }
  });
}
