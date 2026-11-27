import { useEffect, useId, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import type { Activity } from '../../shared/contracts';
import { Check, ChevronDown } from './icons';

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

export function LiveLine({
  item,
  quiet = true,
  history = true,
  clipped = false,
}: {
  item?: Activity;
  quiet?: boolean;
  history?: boolean;
  clipped?: boolean;
}) {
  const labelId = useId();
  const label = useRef<HTMLSpanElement>(null);
  const step = item?.step?.trim();
  const site = item?.doing === 'tool' ? item.site : null;
  const minutes = useQuietMinutes(item?.quietSince ?? '', quiet && Boolean(item));
  const work =
    item?.doing === 'tool'
      ? item.tool
      : item?.doing === 'model' && minutes && item.model
        ? `Waiting for ${item.model}`
        : undefined;
  const described = step || (site && `Using ${site}`) || work;
  const meta = [step ? site || work : null, minutes ? `${minutes} min` : null]
    .filter(Boolean)
    .join(' · ');
  useEffect(() => {
    if (label.current) label.current.title = described ? (label.current.textContent ?? '') : '';
  }, [described, meta]);
  const current = (
    <span className="live-line-current" id={labelId} role="status" ref={label}>
      {described ? (
        <Markdown allowedElements={[]} unwrapDisallowed>
          {described}
        </Markdown>
      ) : item?.doing === 'queued' || item?.doing === 'tool' ? (
        'Working…'
      ) : (
        'Thinking…'
      )}
      {meta && ` · ${meta}`}
    </span>
  );
  const recent = item?.recent ?? [];
  if (!history || !item || !(recent.length || (clipped && described))) return current;
  return (
    <details className="live-line" key={item.turnId}>
      <summary aria-labelledby={labelId}>
        {current}
        <ChevronDown size={14} aria-hidden="true" />
      </summary>
      {recent.length > 0 && (
        <ol aria-label="Recent completed activity">
          {recent.map((entry) => (
            <li key={entry.id}>
              <Check size={12} aria-hidden="true" />
              <span>
                <Markdown allowedElements={[]} unwrapDisallowed>
                  {entry.summary}
                </Markdown>
                {entry.site && <span className="live-line-site"> · {entry.site}</span>}
              </span>
            </li>
          ))}
        </ol>
      )}
    </details>
  );
}
