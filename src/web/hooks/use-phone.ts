import { useSyncExternalStore } from 'react';

const phoneQuery = '(max-width: 720px)';

function subscribe(change: () => void) {
  const media = window.matchMedia?.(phoneQuery);
  media?.addEventListener('change', change);
  return () => media?.removeEventListener('change', change);
}

export function usePhone() {
  return useSyncExternalStore(subscribe, () => window.matchMedia?.(phoneQuery).matches ?? false);
}
