const labels = {
  'darwin-arm64': 'Download for Mac',
  'darwin-x64': 'Download for Mac',
  'win32-x64': 'Download for Windows',
};

async function detectPlatform(nav) {
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

export function startDownload() {
  const button = document.getElementById('download');
  const label = document.getElementById('download-label');
  const others = [...document.querySelectorAll('#platforms [data-platform]')];
  detectPlatform(navigator).then((platform) => {
    if (!platform) return;
    const same = others.find((link) => link.dataset.platform === platform);
    button.href = same.href;
    label.textContent = labels[platform];
    for (const link of others) link.hidden = link === same;
  });
}
