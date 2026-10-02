const desktop = window.ottoDesktop;
const element = (id) => document.getElementById(id);
const parameters = new URLSearchParams(location.search);
const providerNames = { openai: 'OpenAI', anthropic: 'Anthropic' };
const providerLinks = {
  openai: 'https://platform.openai.com/api-keys',
  anthropic: 'https://console.anthropic.com/settings/keys',
};
let mode = ['settings', 'loading'].includes(parameters.get('mode'))
  ? parameters.get('mode')
  : 'onboarding';
let section = ['providers', 'preferences'].includes(parameters.get('section'))
  ? parameters.get('section')
  : 'general';
let step = 1;
let settings = { provider: 'openai', model: '', theme: 'system', keys: {} };
let latestStatus = { phase: 'waiting' };
let busy = false;
let preparing = false;
let initialized = false;
let dirty = false;
let pendingPreferences = {};
const editedKeys = new Map();
const keyViews = new Map();

function selectedProvider() {
  return document.querySelector('input[name="provider"]:checked').value;
}

function hasKey(field) {
  return Boolean(
    settings[
      {
        openaiApiKey: 'hasOpenAIKey',
        anthropicApiKey: 'hasAnthropicKey',
        composioApiKey: 'hasComposioKey',
      }[field]
    ],
  );
}

function providerField() {
  return selectedProvider() === 'openai' ? 'openaiApiKey' : 'anthropicApiKey';
}

function displayError(message = '', preparation = false) {
  const target = element(preparation ? 'preparation-error' : 'error');
  target.textContent = message;
  target.hidden = !message;
}

function applyPreferences(preferences) {
  settings = { ...settings, ...preferences };
  const displayed = mode === 'onboarding' ? { ...settings, ...pendingPreferences } : settings;
  const theme =
    displayed.theme === 'system'
      ? preferences.resolvedTheme ||
        (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
      : displayed.theme;
  document.documentElement.dataset.theme = theme;
  for (const radio of document.querySelectorAll('input[name="theme"]'))
    radio.checked = radio.value === displayed.theme;
  element('launch-at-login').checked = Boolean(displayed.launchAtLogin);
  element('notifications').checked = Boolean(displayed.notifications);
}

function markDirty() {
  dirty =
    selectedProvider() !== settings.provider ||
    [...editedKeys.values()].some((value) => value === null || value.trim());
  element('save-status').textContent = '';
  updateActions();
}

function hideKeys() {
  for (const view of keyViews.values()) view.hide();
}

function makeButton(label, className, action) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  button.textContent = label;
  button.addEventListener('click', action);
  return button;
}

function renderKey(target, field, label, link) {
  keyViews.get(field)?.hide();
  const container = element(target);
  container.replaceChildren();
  const saved = hasKey(field);
  const metadata = settings.keys?.[field];
  let editing = !saved || editedKeys.has(field);
  let revealed = false;
  let revealing = false;
  let timer;
  let request = 0;
  const labelRow = document.createElement('div');
  labelRow.className = 'label-row';
  const labelElement = document.createElement('label');
  labelElement.htmlFor = field;
  labelElement.textContent = label;
  if (field === 'composioApiKey') {
    const logo = document.createElement('span');
    logo.className = 'provider-logo composio';
    logo.setAttribute('aria-hidden', 'true');
    labelElement.prepend(logo);
  }
  labelRow.append(
    labelElement,
    makeButton('Get a key', 'text-button', () => void desktop.openExternal(link)),
  );
  const control = document.createElement('div');
  control.className = 'key-control';
  const input = document.createElement('input');
  input.id = field;
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.placeholder = 'Paste your API key';
  input.type = editing ? 'password' : 'text';
  input.readOnly = !editing;
  input.value = editing ? editedKeys.get(field) || '' : masked();
  const hint = document.createElement('div');
  hint.className = 'key-status';
  const state = document.createElement('span');
  const source = document.createElement('span');
  hint.append(state, source);
  const eye = makeButton('', 'key-action', () => void toggleReveal());
  eye.innerHTML =
    '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M2 10s3-5 8-5 8 5 8 5-3 5-8 5-8-5-8-5Z" stroke="currentColor" stroke-width="1.4"/><circle cx="10" cy="10" r="2.3" stroke="currentColor" stroke-width="1.4"/></svg>';
  const change = makeButton(editing ? 'Cancel' : 'Change', 'key-action', () => {
    hide();
    editing = !editing;
    input.readOnly = !editing;
    input.type = editing ? 'password' : 'text';
    input.value = editing ? '' : masked();
    if (!editing) editedKeys.delete(field);
    refresh();
    if (editing) input.focus();
    markDirty();
  });
  const remove = makeButton('Remove', 'key-action', () => {
    hide();
    editedKeys.set(field, null);
    input.value = '';
    refresh();
    markDirty();
  });
  remove.setAttribute('aria-label', `Remove ${label}`);
  input.addEventListener('input', () => {
    editedKeys.set(field, input.value);
    markDirty();
  });
  control.append(input, eye);
  if (saved) control.append(remove, change);
  container.append(labelRow, control, hint);
  function masked() {
    return '••••••••••••' + (metadata?.suffix ? ' ' + metadata.suffix : '');
  }
  function hide() {
    request += 1;
    clearTimeout(timer);
    if (revealed) {
      if (editing) input.type = 'password';
      else input.value = masked();
    }
    revealed = false;
    refresh();
  }
  function refresh() {
    const clearing = editedKeys.get(field) === null;
    const activeField = settings.provider === 'openai' ? 'openaiApiKey' : 'anthropicApiKey';
    input.readOnly = clearing || !editing;
    eye.hidden = clearing || (!saved && !editing);
    eye.disabled = busy || revealing;
    eye.setAttribute('aria-label', (revealed ? 'Hide ' : 'Show ') + label);
    eye.title = revealed ? 'Hide key' : 'Show key';
    eye.setAttribute('aria-pressed', String(revealed));
    change.textContent = editing ? 'Cancel' : 'Change';
    remove.hidden =
      mode !== 'settings' ||
      !saved ||
      !editing ||
      clearing ||
      (field !== 'composioApiKey' && (field === activeField || !hasKey(activeField)));
    state.textContent = clearing
      ? field === 'composioApiKey'
        ? 'Save to remove this key.'
        : `Save to remove this key. Otto will keep using ${providerNames[settings.provider]}.`
      : editing && saved
        ? 'Save to replace the current key.'
        : '';
    source.textContent =
      !editing && metadata?.source === 'import' ? 'Imported from local setup' : '';
    hint.hidden = !state.textContent && !source.textContent;
  }
  async function toggleReveal() {
    if (revealed) {
      hide();
      return;
    }
    if (editing) {
      input.type = 'text';
      revealed = true;
    } else {
      const token = ++request;
      revealing = true;
      refresh();
      try {
        const value = await desktop.revealKey(field);
        if (token !== request || !document.hasFocus()) return;
        input.value = value;
        revealed = true;
      } catch {
        displayError('Your key could not be shown. Unlock your system key store and try again.');
      } finally {
        revealing = false;
        refresh();
      }
    }
    refresh();
    timer = setTimeout(hide, 20_000);
  }
  keyViews.set(field, { hide });
  refresh();
}

function renderProviders() {
  hideKeys();
  keyViews.clear();
  const provider = selectedProvider();
  renderKey(
    'provider-key-field',
    providerField(),
    providerNames[provider] + ' API key',
    providerLinks[provider],
  );
  renderKey(
    'composio-key-field',
    'composioApiKey',
    'Composio API key',
    'https://platform.composio.dev',
  );
  const models = settings.models?.[provider] || [];
  const current =
    provider === settings.provider
      ? models.find((model) => model.id === settings.model)
      : undefined;
  element('model').textContent =
    (current || models.find((model) => model.recommended))?.label || 'Recommended';
}

function updateActions() {
  const loading = preparing || mode === 'loading';
  element('retry-settings').hidden =
    loading || mode !== 'settings' || !(latestStatus.phase === 'error' || latestStatus.error);
  element('continue').hidden = loading || (mode === 'settings' && section !== 'providers');
  element('continue').disabled = busy || !initialized || (mode === 'settings' && !dirty);
  element('continue').textContent = busy
    ? 'Saving…'
    : mode === 'onboarding'
      ? step === 2
        ? 'Open Otto'
        : 'Continue'
      : 'Save changes';
  element('back').hidden = loading || mode !== 'onboarding' || step === 1;
  element('back').disabled = busy;
  element('action-bar').hidden = loading || (mode === 'settings' && section !== 'providers');
  element('keychain-notice').hidden =
    latestStatus.platform !== 'darwin' || loading || mode !== 'onboarding' || step !== 2;
}

function showPage(focus = false) {
  if (mode === 'loading') {
    showPreparation();
    return;
  }
  preparing = false;
  element('save-status').textContent = '';
  hideKeys();
  displayError();
  const onboarding = mode === 'onboarding';
  document.body.classList.toggle('onboarding', onboarding);
  document.body.classList.remove('loading');
  element('sidebar').hidden = onboarding;
  element('onboarding-brand').hidden = !onboarding;
  element('step').hidden = !onboarding;
  element('step').textContent = step + ' of 3';
  const page = onboarding ? ['providers', 'general'][step - 1] : section;
  element('appearance-section').hidden = onboarding;
  document.title = onboarding ? 'Otto' : 'Settings';
  element('heading').textContent = onboarding
    ? ['Choose your AI provider', 'Keep Otto close'][step - 1]
    : page === 'providers'
      ? 'Providers'
      : page === 'preferences'
        ? 'Preferences'
        : 'General';
  element('intro').textContent = onboarding
    ? [
        'Otto stores data and runs your workspace and browser on this computer. Your AI provider processes requests; browsing and connected apps contact external services.',
        'Choose how Otto stays available to you.',
      ][step - 1]
    : '';
  element('intro').hidden = !onboarding;
  element('providers-panel').hidden = page !== 'providers';
  element('general-panel').hidden = page !== 'general';
  element('preferences-panel').hidden = page !== 'preferences';
  if (page === 'preferences') window.dispatchEvent(new Event('otto:preferences-open'));
  element('preparation').hidden = true;
  element('settings-form').hidden = false;
  for (const item of document.querySelectorAll('[data-section]'))
    item.setAttribute('aria-current', item.dataset.section === page ? 'page' : 'false');
  element('scroll-area').scrollTop = 0;
  if (!onboarding && (latestStatus.phase === 'error' || latestStatus.error))
    displayError(latestStatus.error || latestStatus.message);
  updateActions();
  if (focus && onboarding) element('heading').focus({ preventScroll: true });
}

function setBusy(value) {
  busy = value;
  document.body.dataset.busy = String(value);
  for (const control of document.querySelectorAll(
    '#settings-form input, #settings-form button, #settings-form select, .nav-item',
  ))
    control.disabled = value;
  window.ottoPreferencesForm?.refresh();
  updateActions();
}

function updateStatus(value) {
  latestStatus = value || { phase: 'waiting' };
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
  element('status').textContent =
    active.message ||
    (runtime?.phase === 'ready' ? 'Starting Otto…' : 'Preparing your local workspace…');
  const ready = latestStatus.phase === 'ready' && !failure;
  const progress = element('progress-value');
  progress.classList.toggle('determinate', ready || Boolean(failure));
  progress.style.width = ready ? '100%' : failure ? '0%' : '';
  element('retry').hidden = !failure;
  element('import-runtime').hidden =
    !failure ||
    !(failure.needsRuntimeArchive || runtime?.needsRuntimeArchive) ||
    !desktop.importRuntime;
  element('edit-settings').hidden = !failure;
  if (preparing) {
    displayError(failure?.error || failure?.message || '', true);
    element('heading').textContent = ready
      ? 'Otto is ready'
      : failure
        ? 'Otto needs a moment'
        : 'Getting Otto ready';
    element('preparation-description').textContent = ready
      ? 'Opening your chat.'
      : failure
        ? 'Your choices are kept. Retry preparation or review your setup.'
        : 'Setting up your local workspace and browser. The first launch can take a few minutes.';
  }
  updateActions();
}

function showPreparation() {
  preparing = true;
  hideKeys();
  document.body.classList.add('onboarding', 'loading');
  element('sidebar').hidden = true;
  element('onboarding-brand').hidden = false;
  element('step').hidden = mode !== 'onboarding';
  element('step').textContent = '3 of 3';
  document.title = 'Otto';
  element('settings-form').hidden = true;
  element('preparation').hidden = false;
  element('intro').hidden = true;
  element('scroll-area').scrollTop = 0;
  displayError('', true);
  updateStatus(latestStatus);
}

async function prepare(options) {
  showPreparation();
  try {
    updateStatus(await desktop.prepare(options));
  } catch (error) {
    updateStatus({
      ...latestStatus,
      phase: 'error',
      message: error?.message || 'Otto could not start. Try again.',
    });
  }
}

async function savePreferences(input) {
  if (busy || !initialized) return;
  setBusy(true);
  displayError();
  try {
    settings = await desktop.saveSettings(input);
    applyPreferences(settings);
  } catch (error) {
    displayError(error?.message || 'Your preference could not be saved. Try again.');
    applyPreferences(settings);
  } finally {
    setBusy(false);
  }
}

element('settings-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (
    busy ||
    !initialized ||
    preparing ||
    mode === 'loading' ||
    (mode === 'settings' && section !== 'providers')
  )
    return;
  displayError();
  const input = {};
  if (mode === 'settings' || step === 1) {
    input.provider =
      editedKeys.get(providerField()) === null ? settings.provider : selectedProvider();
    const field = input.provider === 'openai' ? 'openaiApiKey' : 'anthropicApiKey';
    if (!hasKey(field) && !editedKeys.get(field)?.trim()) {
      displayError('Add your ' + providerNames[input.provider] + ' API key to continue.');
      element(field).focus();
      return;
    }
    for (const [name, value] of editedKeys)
      if (value === null || value.trim()) input[name] = value === null ? null : value.trim();
  } else {
    input.launchAtLogin = element('launch-at-login').checked;
    input.notifications = element('notifications').checked;
    input.onboardingCompleted = true;
  }
  setBusy(true);
  try {
    if (input.onboardingCompleted)
      await window.ottoPreferencesForm.flush({ useCurrentTimeZone: true });
    settings = await desktop.saveSettings(input);
    if (input.onboardingCompleted) pendingPreferences = {};
    editedKeys.clear();
    dirty = false;
    document.querySelector('input[name="provider"][value="' + settings.provider + '"]').checked =
      true;
    renderProviders();
    applyPreferences(settings);
    if (mode === 'onboarding' && step === 1) {
      step = 2;
      showPage(true);
    } else await prepare();
  } catch (error) {
    displayError(error?.message || 'Your settings could not be saved. Try again.');
  } finally {
    setBusy(false);
  }
});

for (const radio of document.querySelectorAll('input[name="provider"]'))
  radio.addEventListener('change', () => {
    renderProviders();
    markDirty();
    displayError();
  });
for (const radio of document.querySelectorAll('input[name="theme"]'))
  radio.addEventListener('change', () => {
    if (mode === 'settings') void savePreferences({ theme: radio.value });
  });
for (const [id, key] of [
  ['launch-at-login', 'launchAtLogin'],
  ['notifications', 'notifications'],
]) {
  element(id).addEventListener('change', () => {
    if (mode === 'settings' || key === 'notifications')
      void savePreferences({ [key]: element(id).checked });
    else pendingPreferences[key] = element(id).checked;
  });
}
for (const item of document.querySelectorAll('[data-section]'))
  item.addEventListener('click', () => {
    if (mode !== 'settings' || preparing) return;
    section = item.dataset.section;
    showPage(true);
  });
element('back').addEventListener('click', () => {
  if (busy || preparing || mode !== 'onboarding' || step === 1) return;
  step -= 1;
  showPage(true);
});
element('retry').addEventListener('click', () => void prepare({ retry: true }));
element('retry-settings').addEventListener('click', () => void prepare({ retry: true }));
element('edit-settings').addEventListener('click', async () => {
  if (mode === 'settings') {
    showPage(true);
    return;
  }
  if (mode === 'onboarding') {
    step = 2;
    showPage(true);
    return;
  }
  try {
    await desktop.replayOnboarding();
  } catch {
    displayError('Setup could not be opened. Try again.', true);
  }
});
element('import-runtime').addEventListener('click', async () => {
  displayError('', true);
  try {
    const result = await desktop.importRuntime();
    if (result) updateStatus(result);
    if (preparing && result?.runtime?.phase === 'ready') await prepare();
  } catch (error) {
    displayError(error?.message || 'The runtime could not be installed. Try again.', true);
  }
});
window.addEventListener('blur', hideKeys);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) hideKeys();
});
window.addEventListener('beforeunload', hideKeys);

async function initialize() {
  if (!desktop) {
    displayError('Open Settings from the Otto app.');
    return;
  }
  desktop.onStatus(updateStatus);
  desktop.onPreferences?.(applyPreferences);
  desktop.onNavigate?.((navigation) => {
    if (mode === 'onboarding' && !preparing && !navigation.reset) return;
    if (
      preparing &&
      navigation.mode === 'settings' &&
      ['preparing', 'starting'].includes(latestStatus.phase)
    )
      return;
    if (navigation.mode === mode && mode !== 'settings' && !navigation.reset) return;
    mode = navigation.mode;
    section = navigation.section;
    step = 1;
    showPage(true);
  });
  try {
    const values = await Promise.all([
      desktop.getSettings(),
      desktop.status(),
      desktop.getPreferences(),
    ]);
    settings = values[0];
    latestStatus = values[1];
    document.querySelector('input[name="provider"][value="' + settings.provider + '"]').checked =
      true;
    applyPreferences(values[2]);
    renderProviders();
    initialized = true;
    showPage();
    if (mode === 'loading') showPreparation();
    updateStatus(latestStatus);
  } catch {
    displayError('Your settings could not be loaded. Close this window and open Otto again.');
  }
}

void initialize();
