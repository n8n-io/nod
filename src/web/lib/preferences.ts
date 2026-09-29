import type { AccountPreferences } from '../../shared/account';
import { api } from './api';
import { browserRegionLocale, setDateFormat } from './date-format';
import { pageDataCache } from './page-data-cache';
import { sessionStore } from './session';

let writes: Promise<unknown> = Promise.resolve();
let writesEpoch = -1;
let browserLocaleSave: Promise<void> | undefined;

function currentEpoch() {
  const epoch = sessionStore.getSnapshot().epoch;
  if (writesEpoch !== epoch) {
    writesEpoch = epoch;
    writes = Promise.resolve();
    browserLocaleSave = undefined;
  }
  return epoch;
}

export function savePreferences(change: Partial<AccountPreferences>, signal?: AbortSignal) {
  const epoch = currentEpoch();
  function checkAccount() {
    signal?.throwIfAborted();
    if (epoch !== sessionStore.getSnapshot().epoch)
      throw new DOMException('The account changed.', 'AbortError');
  }
  const write = writes
    .catch(() => {})
    .then(async () => {
      checkAccount();
      const saved = await api<AccountPreferences>('/api/preferences', {
        method: 'PATCH',
        signal,
        body: JSON.stringify(change),
      });
      checkAccount();
      setDateFormat(saved);
      pageDataCache.update<AccountPreferences>('/api/preferences', () => saved);
      return saved;
    });
  writes = write;
  return write;
}

export function saveBrowserLocale(signal?: AbortSignal) {
  currentEpoch();
  if (!browserLocaleSave) {
    const pending = savePreferences({ locale: browserRegionLocale() }, signal)
      .then(() => {})
      .finally(() => {
        if (browserLocaleSave === pending) browserLocaleSave = undefined;
      });
    browserLocaleSave = pending;
  }
  return browserLocaleSave;
}
