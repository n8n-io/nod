(() => {
  const desktop = window.ottoDesktop;
  const element = (id) => document.getElementById(id);
  const controls = {
    locale: element('preference-region'),
    hourCycle: element('preference-clock'),
    timeZone: element('preference-time-zone'),
    quietHoursEnabled: element('preference-quiet-hours'),
    quietStart: element('preference-quiet-start'),
    quietEnd: element('preference-quiet-end'),
  };
  const regions = [
    'GB',
    'US',
    'IE',
    'CA',
    'AU',
    'NZ',
    'IN',
    'ZA',
    'PT',
    'BR',
    'ES',
    'MX',
    'AR',
    'FR',
    'BE',
    'CH',
    'DE',
    'AT',
    'IT',
    'NL',
    'SE',
    'DK',
    'NO',
    'FI',
    'PL',
    'CZ',
    'RO',
    'HU',
    'GR',
    'TR',
    'UA',
    'IL',
    'JP',
    'KR',
    'CN',
    'TW',
  ];
  const names = new Intl.DisplayNames(['en'], { type: 'region' });
  const systemZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const drafts = new Map();
  const operations = new Set();
  const invalid = new Set();
  let loadOperation;
  let preferences;
  let systemRegion;
  let saving = 0;
  let revision = 0;
  let applied = 0;
  let loading = 0;

  function region(value) {
    try {
      return value ? new Intl.Locale(value).maximize().region : null;
    } catch {
      return null;
    }
  }

  function timeZoneRegion(value) {
    let result;
    for (let first = 65; first <= 90; first++) {
      for (let second = 65; second <= 90; second++) {
        const locale = new Intl.Locale(`und-${String.fromCharCode(first, second)}`);
        if (!locale.getTimeZones && !('timeZones' in locale)) return null;
        const zones = locale.getTimeZones?.() ?? locale.timeZones;
        if (zones?.includes(value)) result = locale.region;
      }
    }
    return result;
  }

  function message(id, value = '') {
    const target = element(id);
    target.textContent = value;
    target.hidden = !value;
  }

  function options(select, values) {
    const selected = select.value;
    select.replaceChildren(
      ...values.map(([value, label]) => {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = label;
        return option;
      }),
    );
    select.value = selected;
  }

  function choices(value) {
    systemRegion ||=
      timeZoneRegion(systemZone) ||
      [...navigator.languages, navigator.language].map(region).find(Boolean) ||
      'GB';
    const currentRegion = region(value.locale);
    options(controls.locale, [
      ['', `Automatic (${names.of(systemRegion) || systemRegion})`],
      ...[...new Set([...regions, systemRegion, currentRegion])]
        .filter(Boolean)
        .map((value) => [value, names.of(value) || value])
        .sort((a, b) => a[1].localeCompare(b[1], 'en')),
    ]);
    options(controls.hourCycle, [
      ['auto', 'Automatic'],
      ['h12', '12-hour'],
      ['h23', '24-hour'],
    ]);
    options(controls.timeZone, [
      [systemZone, `Current location (${systemZone.replaceAll('_', ' ')})`],
      ...[
        ...new Set([
          ...(Intl.supportedValuesOf?.('timeZone') || []),
          systemZone,
          value.timeZone,
          'UTC',
        ]),
      ]
        .filter((value) => value && value !== systemZone)
        .sort()
        .map((value) => [value, value.replaceAll('_', ' ')]),
    ]);
  }

  function render() {
    for (const control of Object.values(controls))
      control.disabled = !preferences || document.body.dataset.busy === 'true';
    if (!preferences) return;
    const value = {
      ...preferences,
      ...Object.fromEntries([...drafts].map(([key, edit]) => [key, edit.value])),
    };
    for (const [key, control] of Object.entries(controls)) {
      if (document.activeElement === control || invalid.has(key)) continue;
      if (key === 'quietHoursEnabled') control.checked = value[key];
      else
        control.value =
          key === 'locale'
            ? region(value.locale) || ''
            : key === 'timeZone'
              ? value.timeZone || systemZone
              : (value[key] ?? '');
    }
    element('preference-quiet-times').hidden = !value.quietHoursEnabled;
    let locale = `en-${region(value.locale) || systemRegion}`;
    if (new Intl.DateTimeFormat(locale).resolvedOptions().locale !== locale) locale = 'en-GB';
    element('preferences-example').textContent = new Intl.DateTimeFormat(locale, {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: 'numeric',
      minute: '2-digit',
      timeZone: value.timeZone || systemZone,
      ...(value.hourCycle === 'auto' ? {} : { hourCycle: value.hourCycle }),
    }).format(new Date());
  }

  async function persist(changes) {
    if (!changes.size) return;
    const request = Math.max(...[...changes.values()].map((edit) => edit.revision));
    saving++;
    message('preferences-error');
    message('preferences-status', 'Saving…');
    try {
      const result = await desktop.saveAppPreferences(
        Object.fromEntries([...changes].map(([key, edit]) => [key, edit.value])),
      );
      if (request >= applied) {
        preferences = result.preferences;
        applied = request;
      }
      for (const [key, edit] of changes)
        if (drafts.get(key)?.revision === edit.revision) drafts.delete(key);
    } catch {
      message('preferences-error', 'Preferences could not be saved.');
    } finally {
      saving--;
      render();
      if (!saving) {
        message('preferences-error', drafts.size ? 'Preferences could not be saved.' : '');
        message('preferences-status');
      }
    }
  }

  function save(changes = new Map(drafts)) {
    const operation = persist(changes);
    operations.add(operation);
    void operation.finally(() => operations.delete(operation));
    return operation;
  }

  async function read() {
    if (saving) return;
    if (drafts.size) {
      void save();
      return;
    }
    const request = ++loading;
    const before = revision;
    if (!preferences) message('preferences-status', 'Loading…');
    message('preferences-error');
    render();
    try {
      const result = await desktop.getAppPreferences();
      if (request !== loading || before !== revision || saving) return;
      preferences = result.preferences;
      choices(preferences);
      render();
      message('preferences-status');
    } catch {
      if (request !== loading || before !== revision) return;
      message('preferences-status');
      message('preferences-error', 'Preferences could not be loaded.');
    }
  }

  function load() {
    if (!loadOperation) {
      loadOperation = read().finally(() => {
        loadOperation = undefined;
      });
    }
    return loadOperation;
  }

  window.ottoPreferencesForm = {
    refresh: render,
    async flush({ useCurrentTimeZone = false } = {}) {
      if (!preferences) await load();
      if (!preferences || invalid.size)
        throw new Error('Check your date and time preferences before continuing.');
      while (operations.size) await Promise.all([...operations]);
      if (useCurrentTimeZone && !(drafts.get('timeZone')?.value ?? preferences.timeZone)) {
        drafts.set('timeZone', { value: systemZone, revision: ++revision });
      }
      if (drafts.size) await save();
      if (drafts.size) throw new Error('Your preferences could not be saved. Try again.');
    },
  };

  for (const [key, control] of Object.entries(controls)) {
    control.addEventListener('change', () => {
      if (!preferences) return;
      let value = key === 'quietHoursEnabled' ? control.checked : control.value;
      if (key === 'locale') value = value ? `en-${value}` : null;
      if (
        (key === 'quietStart' || key === 'quietEnd') &&
        !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)
      ) {
        invalid.add(key);
        message('preferences-error', 'Choose a valid time.');
        return;
      }
      invalid.delete(key);
      if (key === 'quietHoursEnabled' && !value) {
        for (const time of ['quietStart', 'quietEnd']) {
          invalid.delete(time);
          controls[time].value = drafts.get(time)?.value ?? preferences[time];
        }
      }
      const edit = { value, revision: ++revision };
      drafts.set(key, edit);
      render();
      void save(new Map([[key, edit]]));
    });
  }
  window.addEventListener('otto:preferences-open', () => void load());
  render();
})();
