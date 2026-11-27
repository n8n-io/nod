import {
  BrowserWindow,
  clipboard,
  ClipboardItem,
  globalShortcut,
  powerMonitor,
  screen,
} from 'electron';

const mac = process.platform === 'darwin';
const stopShortcut = mac ? 'CommandOrControl+Shift+Escape' : 'Control+Alt+Shift+Escape';
const stopLabel = mac ? '⌘⇧⎋' : 'Ctrl+Alt+Shift+Esc';
const wayland = process.platform === 'linux' && process.env.XDG_SESSION_TYPE === 'wayland';
const pillSize = { width: 380, height: 48 };

const glowPage = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;height:100%;background:transparent;overflow:hidden}
.glow{position:fixed;inset:0;border-radius:12px;box-shadow:inset 0 0 0 2px rgba(255,145,172,.95),inset 0 0 32px 8px rgba(255,92,138,.5);animation:pulse 2s ease-in-out infinite;will-change:opacity}
@keyframes pulse{50%{opacity:.5}}
@media (prefers-reduced-motion:reduce){.glow{animation:none}}
</style></head><body><div class="glow"></div></body></html>`;

const pillPage = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;height:100%;background:transparent;overflow:hidden;font:500 13px/1 -apple-system,BlinkMacSystemFont,system-ui,'Segoe UI',sans-serif}
.pill{box-sizing:border-box;height:40px;margin:4px auto;display:flex;align-items:center;gap:10px;padding:0 6px 0 14px;width:max-content;max-width:372px;border-radius:20px;background:#fff;color:#1a1a1a;box-shadow:0 0 0 1px rgba(255,145,172,.9),0 6px 18px rgba(135,0,60,.25)}
.dot{width:8px;height:8px;border-radius:50%;background:#ff5c8a;animation:pulse 1.2s ease-in-out infinite}
@keyframes pulse{50%{opacity:.35}}
@media (prefers-reduced-motion:reduce){.dot{animation:none}}
.quiet .dot{animation:none;opacity:.8}
.text{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
button{font:inherit;border:0;border-radius:14px;height:28px;padding:0 12px;background:#ff91ac;color:#1a1a1a;cursor:pointer;display:flex;align-items:center;gap:6px}
button:hover{background:#ffbcca}
kbd{font:inherit;opacity:.6}
@media (prefers-color-scheme:dark){.pill{background:#1f1f1f;color:#f5f5f5}}
</style></head><body><div class="pill"><span class="dot"></span><span class="text" id="text"></span><button id="stop">Stop <kbd>${stopLabel}</kbd></button></div>
<script>
document.getElementById('stop').addEventListener('click',()=>{document.title='stop-'+Date.now()});
window.render=(text,quiet,armed)=>{document.getElementById('text').textContent=text;document.body.classList.toggle('quiet',quiet);document.querySelector('kbd').hidden=!armed};
</script></body></html>`;

function page(html) {
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

function overlayWindow(options) {
  const window = new BrowserWindow({
    ...options,
    show: false,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: false,
    type: 'panel',
    webPreferences: {
      partition: 'nod-computer-overlay',
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  window.setAlwaysOnTop(true, 'floating');
  window.setVisibleOnAllWorkspaces(true, {
    visibleOnFullScreen: true,
    skipTransformProcessType: true,
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  return window;
}

export function createComputerOverlay({ onStop, focusSelf }) {
  let glow;
  let pill;
  let ready;
  let shown = false;
  let latest = 0;

  function windows() {
    ready ??= (async () => {
      glow = overlayWindow({ width: 100, height: 100 });
      glow.setIgnoreMouseEvents(true);
      pill = overlayWindow({ ...pillSize, acceptFirstMouse: true });
      pill.on('page-title-updated', (event, title) => {
        event.preventDefault();
        if (title.startsWith('stop-')) stop();
      });
      await Promise.all([glow.loadURL(page(glowPage)), pill.loadURL(page(pillPage))]);
    })();
    return ready;
  }

  function stop() {
    hide();
    onStop();
  }

  function place(window) {
    const area = screen.getDisplayMatching(window).workArea;
    const left = Math.max(window.x, area.x);
    const top = Math.max(window.y, area.y);
    const bounds = {
      x: left,
      y: top,
      width: Math.max(1, Math.min(window.x + window.width, area.x + area.width) - left),
      height: Math.max(1, Math.min(window.y + window.height, area.y + area.height) - top),
    };
    const x = Math.round(
      Math.min(
        Math.max(bounds.x + (bounds.width - pillSize.width) / 2, area.x + 8),
        area.x + area.width - pillSize.width - 8,
      ),
    );
    const below = bounds.y + bounds.height + 8;
    const y =
      below + pillSize.height <= area.y + area.height
        ? below
        : bounds.y + bounds.height - pillSize.height - 8;
    glow.setBounds(bounds);
    pill.setBounds({ x, y: Math.round(y), ...pillSize });
  }

  function placeAtTop() {
    const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    pill.setBounds({
      x: Math.round(area.x + (area.width - pillSize.width) / 2),
      y: area.y + 8,
      ...pillSize,
    });
  }

  async function show({ app, bounds, waiting = false, background = false }) {
    const call = ++latest;
    await windows();
    if (call !== latest) return;
    const framed = !background && !wayland;
    if (!framed) placeAtTop();
    else {
      const rounded = {
        x: Math.round(bounds.x),
        y: Math.round(bounds.y),
        width: Math.round(bounds.width),
        height: Math.round(bounds.height),
      };
      place(process.platform === 'win32' ? screen.screenToDipRect(null, rounded) : rounded);
    }
    const text = background
      ? `Nod is working in ${app}`
      : waiting
        ? `Nod will use ${app} when you pause`
        : `Nod is using ${app}`;
    const armed =
      globalShortcut.isRegistered(stopShortcut) || globalShortcut.register(stopShortcut, stop);
    await pill.webContents
      .executeJavaScript(`render(${JSON.stringify(text)},${background},${armed})`)
      .catch(() => {});
    if (call !== latest) return;
    if (framed) glow.showInactive();
    else glow.hide();
    pill.showInactive();
    shown = true;
  }

  function hide() {
    latest++;
    if (globalShortcut.isRegistered(stopShortcut)) globalShortcut.unregister(stopShortcut);
    if (!shown) return;
    shown = false;
    glow?.hide();
    pill?.hide();
  }

  return {
    ownPid: process.pid,
    show: (state) => void show(state),
    hide,
    focusSelf,
    idleSeconds: () => powerMonitor.getSystemIdleTime(),
    clipboard: {
      save: async () =>
        Promise.all(
          (await clipboard.read()).map(async (item) =>
            Object.fromEntries(
              await Promise.all(item.types.map(async (type) => [type, await item.getType(type)])),
            ),
          ),
        ),
      write: (text) => clipboard.writeText(text),
      restore: (saved) =>
        saved.length
          ? clipboard.write(saved.map((item) => new ClipboardItem(item)))
          : clipboard.clear(),
    },
    destroy() {
      hide();
      glow?.destroy();
      pill?.destroy();
    },
  };
}
