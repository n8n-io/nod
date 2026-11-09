import { useEffect, useState } from 'react';
import Markdown from 'react-markdown';
import type { Activity } from '../../shared/contracts';

const quietMinutes = (since: string) => Math.floor((Date.now() - Date.parse(since)) / 60_000);

function useQuietMinutes(since: string, enabled: boolean) {
  const [minutes, setMinutes] = useState(() => quietMinutes(since));
  useEffect(() => {
    setMinutes(quietMinutes(since));
    if (!enabled) return;
    const timer = setInterval(() => setMinutes(quietMinutes(since)), 15_000);
    return () => clearInterval(timer);
  }, [since, enabled]);
  return enabled && minutes > 0 ? minutes : 0;
}

export function liveSummary(item: Activity) {
  const step = item.step?.trim();
  const site = item.doing === 'tool' ? item.site : null;
  return {
    primary: step || site || (item.doing === 'model' ? 'Thinking…' : 'Working…'),
    site: step ? site : null,
    described: Boolean(step || site),
  };
}

export function LiveLine({ item, quiet = true }: { item: Activity; quiet?: boolean }) {
  const { primary, site } = liveSummary(item);
  const minutes = useQuietMinutes(item.quietSince, quiet);
  const meta = [site, minutes ? `${minutes} min` : null].filter(Boolean).join(' · ');
  return (
    <span key={primary}>
      <Markdown allowedElements={[]} unwrapDisallowed>
        {primary}
      </Markdown>
      {meta && ` · ${meta}`}
    </span>
  );
}
