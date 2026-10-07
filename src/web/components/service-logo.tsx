import { useState } from 'react';
import { Link2 } from 'lucide-react';
import type { Connection } from '../../shared/contracts';

const logos = new Set([
  'gmail',
  'googlecalendar',
  'googledrive',
  'googlesheets',
  'googledocs',
  'slack',
  'notion',
  'linear',
]);

export function ServiceLogo({ connection, size = 24 }: { connection: Connection; size?: number }) {
  const [failed, setFailed] = useState<string>();
  const source = logos.has(connection.slug)
    ? `/logos/${connection.slug}.svg`
    : connection.connectionId
      ? `/api/apps/${encodeURIComponent(connection.connectionId)}/icon`
      : undefined;
  return source && failed !== source ? (
    <img
      src={source}
      alt=""
      width={size}
      height={size}
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      onError={() => setFailed(source)}
    />
  ) : (
    <Link2 size={size} aria-hidden="true" />
  );
}
