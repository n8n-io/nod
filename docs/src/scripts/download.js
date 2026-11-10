const installers = {
  'darwin-arm64': { file: 'nod-arm64.dmg', label: 'Download for Mac' },
  'darwin-x64': { file: 'nod-x64.dmg', label: 'Download for Mac' },
  'win32-x64': { file: 'nod-Setup-x64.exe', label: 'Download for Windows' },
  mobile: { label: 'Install on your computer' },
};
const release = 'https://github.com/n8n-io/nod/releases/latest/download';

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
  let bitness = '';
  try {
    const values = await hints?.getHighEntropyValues?.(['architecture', 'bitness']);
    architecture = values?.architecture?.toLowerCase() || '';
    bitness = values?.bitness || '';
  } catch {}
  const x64 =
    ['x64', 'x86_64', 'amd64'].includes(architecture) ||
    (architecture === 'x86' && bitness === '64');
  if (/mac/i.test(platform)) {
    if (['arm', 'arm64'].includes(architecture)) return 'darwin-arm64';
    return x64 ? 'darwin-x64' : null;
  }
  if (/win/i.test(platform)) return x64 ? 'win32-x64' : null;
  return null;
}

export function startDownload() {
  const links = document.querySelectorAll('[data-download]');
  detectPlatform(navigator).then((platform) => {
    const installer = installers[platform];
    if (!installer) return;
    for (const link of links) {
      if (installer.file) link.href = `${release}/${installer.file}`;
      if (link.dataset.download === 'label') link.textContent = installer.label;
    }
  });
}
