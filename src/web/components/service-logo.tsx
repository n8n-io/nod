import { useState } from 'react';
import { Link2 } from './icons';
import { integrationServiceIds } from '../../shared/integrations.ts';

const bundled = new Set(integrationServiceIds);

export function ServiceLogo({
  slug,
  logoUrl,
  connectionId,
  size = 24,
}: {
  slug: string;
  logoUrl?: string;
  connectionId?: string;
  size?: number;
}) {
  const [failed, setFailed] = useState<string[]>([]);
  const base = slug.replace(/_mcp$/, '');
  const source = [
    bundled.has(base) ? `/logos/${base}.svg` : undefined,
    logoUrl,
    connectionId ? `/api/apps/${encodeURIComponent(connectionId)}/icon` : undefined,
  ].find((url) => url && !failed.includes(url));
  return source ? (
    <img
      className="service-logo"
      src={source}
      alt=""
      width={size}
      height={size}
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      onError={() => setFailed((current) => [...current, source])}
    />
  ) : (
    <Link2 className="service-logo" size={size} aria-hidden="true" />
  );
}
