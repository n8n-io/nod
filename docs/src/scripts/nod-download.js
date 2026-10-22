const brokers = [
  'https://internal.users.n8n.cloud/webhook/nod/desktop',
  'https://internal.users.n8n.cloud/webhook/otto-desktop',
];
const labels = {
  'darwin-arm64': 'Download for Mac',
  'darwin-x64': 'Download for Mac',
  'win32-x64': 'Download for Windows',
};

export async function detectPlatform(nav) {
  const agent = nav.userAgent || '';
  if (
    /iPhone|iPad|iPod|Android/i.test(agent) ||
    (/Macintosh/.test(agent) && nav.maxTouchPoints > 1)
  )
    return null;
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

async function latest(platform) {
  for (const broker of brokers) {
    try {
      const response = await fetch(`${broker}/releases?installer=true&platform=${platform}`);
      if (!response.ok) continue;
      const release = await response.json();
      const url = release.disk?.url ?? release.installer?.url;
      if (url?.startsWith('https://internal.users.n8n.cloud/')) return url;
    } catch {}
  }
  return null;
}

async function download(link) {
  location.href = (await latest(link.dataset.platform)) ?? link.href;
}

export async function startDownload() {
  const button = document.getElementById('download');
  const label = document.getElementById('download-label');
  const others = [...document.querySelectorAll('#platforms [data-platform]')];
  const platform = await detectPlatform(navigator);
  if (platform) {
    const same = others.find((link) => link.dataset.platform === platform);
    button.dataset.platform = platform;
    button.href = same.href;
    label.textContent = labels[platform];
    for (const link of others) link.hidden = link === same;
  }
  for (const link of [button, ...others])
    link.addEventListener('click', (event) => {
      event.preventDefault();
      download(link);
    });
}
