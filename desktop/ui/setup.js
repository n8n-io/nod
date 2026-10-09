const desktop = window.ottoDesktop;
const element = (id) => document.getElementById(id);
let loading = new URLSearchParams(location.search).get('mode') === 'loading';
let initialized = false;
let busy = false;
let latestStatus = { phase: 'idle' };

function error(message = '', preparation = false) {
  const target = element(preparation ? 'preparation-error' : 'error');
  target.textContent = message;
  target.hidden = !message;
}

function applyPreferences(value) {
  document.documentElement.dataset.theme =
    value.theme === 'system'
      ? value.resolvedTheme ||
        (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
      : value.theme;
  element('launch-at-login').checked = value.launchAtLogin;
  element('notifications').checked = value.notifications;
}

function render() {
  element('setup-form').hidden = loading;
  element('intro').hidden = loading;
  element('actions').hidden = loading;
  element('preparation').hidden = !loading;
  for (const control of document.querySelectorAll('#setup-form input, #continue'))
    control.disabled = busy || !initialized;
  element('continue').textContent = busy ? 'Saving…' : 'Open Otto';
  element('keychain-notice').hidden = latestStatus.platform !== 'darwin';
  if (!loading) {
    element('heading').textContent = 'Set up your computer';
    window.ottoSetupAnalytics?.step('preferences');
    return;
  }
  const runtime = latestStatus.runtime;
  const failure =
    latestStatus.phase === 'error' || latestStatus.error
      ? latestStatus
      : runtime?.phase === 'error'
        ? runtime
        : null;
  const active =
    failure ||
    (runtime && runtime.phase !== 'ready' && !['starting', 'ready'].includes(latestStatus.phase)
      ? runtime
      : latestStatus);
  const ready = latestStatus.phase === 'ready' && !failure;
  window.ottoSetupAnalytics?.step(failure ? 'error' : ready ? 'ready' : 'preparing');
  if (ready) void window.ottoSetupAnalytics?.completed();
  element('heading').textContent = ready
    ? 'Otto is ready'
    : failure
      ? 'Setup needs a moment'
      : 'Getting Otto ready';
  element('preparation-description').textContent = ready
    ? 'Opening Otto.'
    : 'Preparing your workspace and browser. The first launch can take a few minutes.';
  element('status').textContent = failure ? '' : active.message || 'Preparing…';
  const progress = element('progress-value');
  progress.classList.toggle('determinate', ready || Boolean(failure));
  progress.style.width = ready ? '100%' : failure ? '0%' : '';
  element('retry').hidden = !failure;
  element('review-setup').hidden = !failure;
  element('install-wsl').hidden = !failure || !(failure.needsWsl || runtime?.needsWsl);
  element('install-wsl').disabled = busy;
  element('import-runtime').hidden =
    !failure || !(failure.needsRuntimeArchive || runtime?.needsRuntimeArchive);
  error(failure?.error || failure?.message || '', true);
}

async function prepare(options) {
  loading = true;
  render();
  try {
    latestStatus = await desktop.prepare(options);
  } catch (cause) {
    latestStatus = {
      ...latestStatus,
      phase: 'error',
      error: cause.message || 'Otto could not start. Try again.',
    };
  }
  render();
}

element('setup-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (busy || !initialized || loading) return;
  busy = true;
  error();
  render();
  try {
    await desktop.saveSettings({
      launchAtLogin: element('launch-at-login').checked,
      notifications: element('notifications').checked,
      onboardingCompleted: true,
    });
    await prepare();
  } catch (cause) {
    error(cause.message || 'Your choices could not be saved. Try again.');
  } finally {
    busy = false;
    render();
  }
});
for (const field of ['notifications', 'launch-at-login'])
  element(field).addEventListener('change', async () => {
    if (busy || !initialized) return;
    busy = true;
    const enabled = element(field).checked;
    render();
    try {
      await desktop.saveSettings({
        notifications: element('notifications').checked,
        launchAtLogin: element('launch-at-login').checked,
      });
    } catch (cause) {
      element(field).checked = !enabled;
      error(cause.message || 'Your choice could not be updated.');
    } finally {
      busy = false;
      render();
    }
  });
element('retry').addEventListener('click', () => void prepare({ retry: true }));
element('install-wsl').addEventListener('click', async () => {
  if (busy) return;
  busy = true;
  render();
  try {
    latestStatus = await desktop.installWsl();
  } catch (cause) {
    latestStatus = {
      ...latestStatus,
      error: cause.message || 'Windows could not install WSL. Try again.',
    };
  } finally {
    busy = false;
    render();
  }
});
element('review-setup').addEventListener('click', () => {
  loading = false;
  render();
});
element('import-runtime').addEventListener('click', async () => {
  try {
    const result = await desktop.importRuntime();
    if (result) latestStatus = result;
    if (result?.runtime?.phase === 'ready') await prepare();
    render();
  } catch (cause) {
    error(cause.message || 'The runtime could not be installed. Try again.', true);
  }
});

async function initialize() {
  if (!desktop) return error('Open Otto to finish setup.');
  desktop.onStatus((value) => {
    latestStatus = value;
    render();
  });
  desktop.onPreferences(applyPreferences);
  desktop.onNavigate((value) => {
    if (value.reset) loading = false;
    else if (value.mode === 'loading') loading = true;
    render();
  });
  try {
    const [preferences, status] = await Promise.all([desktop.getPreferences(), desktop.status()]);
    applyPreferences(preferences);
    latestStatus = status;
    initialized = true;
    render();
  } catch {
    error('Your choices could not be loaded. Close this window and open Otto again.');
  }
}
void initialize();
