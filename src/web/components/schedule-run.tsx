import { useRef, useState } from 'react';
import type { ScheduleRunPresentation } from '../../shared/presentation';
import { appPages } from '../../shared/app-links';
import { api, errorMessage } from '../lib/api';
import { formatDateTime, formatTime, useDateFormat } from '../lib/date-format';
import { schedulesPath, uncertainScheduleMutation } from '../lib/schedule-reconciliation';
import { Check, CircleAlert, Play, Repeat, Server } from './icons';
import { Button } from './ui';

const lateAfterMs = 10 * 60_000;

function runs(count: number) {
  return `${count >= 100 ? '100 or more' : count} ${count === 1 ? 'run' : 'runs'}`;
}

function lateness(run: ScheduleRunPresentation) {
  const minutes = Math.round((Date.parse(run.startedAt) - Date.parse(run.dueAt)) / 60_000);
  const hours = Math.floor(minutes / 60);
  return hours ? `${hours} h ${minutes % 60} min` : `${minutes} min`;
}

function skippedText(run: ScheduleRunPresentation) {
  const stopped = run.skipped.filter((skip) => skip.reason === 'stopped').length;
  const paused = run.skipped.length - stopped;
  return [
    stopped ? `${runs(stopped)} skipped while Nod was off or this computer was asleep.` : '',
    paused ? `${runs(paused)} skipped while the model was paused after failed requests.` : '',
  ]
    .filter(Boolean)
    .join(' ');
}

function RunNow({ run }: { run: ScheduleRunPresentation }) {
  const [state, setState] = useState<'idle' | 'busy' | 'started'>('idle');
  const [error, setError] = useState('');
  const pending = useRef<{ requestId: string; expectedRevision: number } | null>(null);
  async function start() {
    setState('busy');
    setError('');
    const input = (pending.current ??= {
      requestId: crypto.randomUUID(),
      expectedRevision: run.revision,
    });
    try {
      await api(`${schedulesPath}/${encodeURIComponent(run.scheduleId)}/run`, {
        method: 'POST',
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(45_000),
      });
      pending.current = null;
      setState('started');
    } catch (cause) {
      const uncertain = uncertainScheduleMutation(cause);
      if (!uncertain) pending.current = null;
      setError(
        uncertain
          ? `Could not confirm that the run started. ${errorMessage(cause)} Select Run now again to check or start the same run.`
          : errorMessage(cause),
      );
      setState('idle');
    }
  }
  return (
    <>
      {state === 'started' ? (
        <span className="schedule-run-started" role="status">
          <Check size={14} aria-hidden="true" />
          Started
        </span>
      ) : (
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={state === 'busy'}
          onClick={() => void start()}
        >
          <Play size={14} aria-hidden="true" />
          {state === 'busy' ? 'Starting…' : 'Run now'}
        </Button>
      )}
      {error && (
        <p className="schedule-run-error" role="alert">
          {error}
        </p>
      )}
    </>
  );
}

export function ScheduleRunTrack({ run }: { run: ScheduleRunPresentation }) {
  const format = useDateFormat();
  const zoned = { ...format, timeZone: run.timeZone };
  const failed = run.outcome === 'failed';
  const late = Date.parse(run.startedAt) - Date.parse(run.dueAt) > lateAfterMs;
  const final = {
    at: late ? run.startedAt : run.dueAt,
    state: failed ? 'failed' : 'ran',
    label: late ? (failed ? 'Tried' : 'Ran') : 'Due',
  };
  const day = (value: string) =>
    new Intl.DateTimeFormat('en-CA', { timeZone: run.timeZone }).format(new Date(value));
  const time = (value: string) =>
    day(value) === day(final.at)
      ? formatTime(value, zoned)
      : formatDateTime(value, format, { timeZone: run.timeZone, weekday: true });
  const earlier = [
    ...run.skipped.map((skip) => ({ at: skip.at, state: 'missed', label: '' })),
    ...(late ? [{ at: run.dueAt, state: 'due', label: 'Due' }] : []),
  ].sort((first, second) => Date.parse(first.at) - Date.parse(second.at));
  const latest = earlier.findLastIndex((mark) => mark.state !== 'due');
  const kept = (index: number) =>
    index === 0 || index === latest || earlier[index]!.state === 'due';
  const marks: { at: string; state: string; label: string }[] = [];
  let hidden = 0;
  earlier.forEach((mark, index) => {
    if (!kept(index)) return void hidden++;
    if (hidden) marks.push({ at: '', state: 'gap', label: `+${hidden}` });
    hidden = 0;
    marks.push(mark);
  });
  const skipped = skippedText(run);
  return (
    <section
      className="schedule-run-track"
      data-outcome={run.outcome}
      aria-label={failed ? `${run.title} didn't run` : `${run.title} ran`}
    >
      <header className="schedule-run-track-header">
        <Repeat size={14} aria-hidden="true" />
        <span className="schedule-run-track-title">{run.title}</span>
      </header>
      <ol className="schedule-run-line">
        {[...marks, final].map((mark, index) => (
          <li key={`${mark.at}-${index}`} data-state={mark.state}>
            <span className="schedule-run-mark" aria-hidden="true" />
            <span className="schedule-run-time">
              {mark.label}
              {mark.label && mark.at ? ' ' : ''}
              {mark.at && time(mark.at)}
              <span className="sr-only">
                {mark.state === 'failed'
                  ? ', did not run'
                  : mark.state === 'ran'
                    ? ', ran'
                    : mark.state === 'gap'
                      ? ' more skipped runs'
                      : mark.state === 'due'
                        ? ''
                        : ', skipped'}
              </span>
            </span>
          </li>
        ))}
        {failed && run.nextRunAt && (
          <li data-state="next">
            <span className="schedule-run-mark" aria-hidden="true" />
            <span className="schedule-run-time">Next {time(run.nextRunAt)}</span>
          </li>
        )}
      </ol>
      {failed ? (
        <div className="schedule-run-track-body">
          <p className="schedule-run-sentence">
            <CircleAlert size={16} aria-hidden="true" />
            <span>
              {late && `Tried at ${time(run.startedAt)}, when Nod was running again. `}
              {run.reason}
              {run.reason && !/[.!?]$/.test(run.reason) ? '.' : ''}
              {run.code && <code className="schedule-run-code">{run.code}</code>}
            </span>
          </p>
          {skipped && (
            <p className="schedule-run-sentence schedule-run-sentence-quiet">{skipped}</p>
          )}
          <div className="schedule-run-track-actions">
            <RunNow run={run} />
            {run.link === 'server' && (
              <a
                className="schedule-run-hint"
                href="https://nod.n8n.io/docs/deploy/self-host/"
                target="_blank"
                rel="noreferrer"
              >
                <Server size={14} aria-hidden="true" />
                Keep schedules running while this computer sleeps
              </a>
            )}
            {run.link === 'models' && (
              <a className="schedule-run-hint" href="/settings/models">
                Check the model in {appPages['/settings/models']}
              </a>
            )}
          </div>
        </div>
      ) : (
        <p className="schedule-run-sentence schedule-run-sentence-quiet">
          {late && `Started ${time(run.startedAt)}, ${lateness(run)} late. `}
          {skipped}
        </p>
      )}
    </section>
  );
}
