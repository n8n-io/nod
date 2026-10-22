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

const ready = new Map();
const pending = new Map();

function prepare(platform) {
  if (!pending.has(platform))
    pending.set(
      platform,
      latest(platform).then((url) => {
        if (url) ready.set(platform, url);
        else pending.delete(platform);
        return url;
      }),
    );
  return pending.get(platform);
}

async function wait(link, label) {
  if (link.getAttribute('aria-busy') === 'true') return;
  const text = label.textContent;
  link.setAttribute('aria-busy', 'true');
  label.textContent = 'Preparing download…';
  location.href = (await prepare(link.dataset.platform)) ?? link.href;
  setTimeout(() => {
    link.removeAttribute('aria-busy');
    label.textContent = text;
  }, 4000);
}

export function startDownload() {
  const button = document.getElementById('download');
  const label = document.getElementById('download-label');
  const others = [...document.querySelectorAll('#platforms [data-platform]')];
  for (const link of [button, ...others]) {
    const warm = () => prepare(link.dataset.platform);
    link.addEventListener('pointerenter', warm);
    link.addEventListener('focus', warm);
    link.addEventListener('click', (event) => {
      const url = ready.get(link.dataset.platform);
      if (url) {
        link.href = url;
        return;
      }
      event.preventDefault();
      wait(link, link === button ? label : link);
    });
  }
  detectPlatform(navigator).then((platform) => {
    if (!platform) return;
    const same = others.find((link) => link.dataset.platform === platform);
    button.dataset.platform = platform;
    button.href = same.href;
    label.textContent = labels[platform];
    for (const link of others) link.hidden = link === same;
  });
}
