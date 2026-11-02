import { useEffect } from 'react';
import type { AccountPreferences } from '../../shared/account';
import { savePreferences } from '../lib/preferences';
import { usePageData } from './use-page-data';

export function useBrowserTimeZone() {
  const { data } = usePageData<AccountPreferences>('/api/preferences');
  const unset = data?.timeZone === null;
  useEffect(() => {
    if (unset)
      void savePreferences(
        { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone },
        undefined,
        'automatic',
      ).catch(() => {});
  }, [unset]);
}
