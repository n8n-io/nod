import { useSyncExternalStore } from 'react';

const phoneQuery = '(max-width: 720px)';

export function usePhone() {
  return useSyncExternalStore(
    (change) => {
      const media = window.matchMedia?.(phoneQuery);
      media?.addEventListener('change', change);
      return () => media?.removeEventListener('change', change);
    },
    () => window.matchMedia?.(phoneQuery).matches ?? false,
  );
}
