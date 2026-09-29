import { useEffect, useState } from 'react';
import { ArrowUpRight, CalendarClock, Clock3, LoaderCircle } from 'lucide-react';
import type { InspectorWorkItem, InspectorWorkResponse } from '../../shared/inspector-work';
import { api, errorMessage } from '../lib/api';
import {
  formatDateTime,
  formatRelativeTime,
  useDateFormat,
  type DateFormat,
} from '../lib/date-format';
import { Button, Loading, Notice } from './ui';

export function workStatus(item: InspectorWorkItem) {
  if (item.status === 'running') return 'Working';
  if (item.status === 'queued') return 'Queued';
  if (item.status === 'waiting_credentials') return 'Needs sign-in';
  return (
    (
      {
        approval: 'Needs approval',
        manual_control: 'Under your control',
        recovery: 'Needs review',
        question: 'Waiting for your answer',
      } as Record<string, string>
    )[item.waitingReason ?? ''] ?? 'Waiting for you'
  );
}

function scheduledTime(value: string | null, timeZone: string, format: DateFormat) {
  if (!value) return 'Time not scheduled';
  try {
    return `${formatDateTime(value, format, { timeZone })} · ${timeZone}`;
  } catch {
    return 'Schedule time unavailable';
  }
}

export function InspectorWork({ onInspect }: { onInspect(taskId: string): void }) {
  const dateFormat = useDateFormat();
  const [data, setData] = useState<InspectorWorkResponse | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try {
        if (document.hidden) return;
        const next = await api<InspectorWorkResponse>('/api/inspector/work', {
          signal: controller.signal,
        });
        if (!controller.signal.aborted) {
          setData(next);
          setError('');
        }
      } catch (cause) {
        if (!controller.signal.aborted) setError(errorMessage(cause));
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(() => void refresh(), 5000);
      }
    }
    void refresh();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, []);
  return (
    <div className="inspector-work" aria-label="Current and upcoming work">
      {error && <Notice>{error}</Notice>}
      {!data && !error && <Loading label="Loading current work…" />}
      {data?.scope === 'owner' && (
        <>
          <section className={`inspector-work-section${!data.active.length ? ' is-empty' : ''}`}>
            <div className="inspector-section-heading">
              <h3>Now</h3>
              <span>
                {data.active.length
                  ? `All activity · ${data.activeTotal}`
                  : 'Nothing running or waiting'}
              </span>
            </div>
            {Boolean(data.active.length) && (
              <div className="inspector-work-list">
                {data.active.map((item) => (
                  <div className="inspector-work-row" key={item.taskId}>
                    <span className={`inspector-work-status work-${item.status}`}>
                      {item.status === 'running' && <LoaderCircle size={12} className="spin" />}
                      {workStatus(item)}
                    </span>
                    <strong>{item.title}</strong>
                    <small>
                      {
                        {
                          conversation: 'Your request',
                          schedule: 'Scheduled work',
                          review: 'Goal and context review',
                          event: 'App update',
                        }[item.source]
                      }
                      {item.queuedInputs > 0 &&
                        ` · ${item.queuedInputs} ${item.queuedInputs === 1 ? 'follow-up' : 'follow-ups'} queued`}
                      {item.executions > 1 && ` · ${item.executions} active executions`}
                    </small>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Inspect ${item.title}`}
                      onClick={() => onInspect(item.taskId)}
                    >
                      <ArrowUpRight size={15} />
                    </Button>
                  </div>
                ))}
              </div>
            )}
            {data.activeTotal > data.active.length && (
              <p className="inspector-data-note">
                Showing {data.active.length} of {data.activeTotal} active outcomes and requests.
                Running work comes first.
              </p>
            )}
          </section>
          <section className={`inspector-work-section${!data.upcoming.length ? ' is-empty' : ''}`}>
            <div className="inspector-section-heading">
              <h3>Next up</h3>
              <span>
                {data.upcomingTotal > 0
                  ? `${data.upcomingTotal} scheduled`
                  : 'No upcoming schedules'}
              </span>
            </div>
            {data.upcoming.map((item) => (
              <div className="inspector-upcoming-row" key={item.id}>
                <CalendarClock size={15} />
                <div>
                  <strong>{item.title}</strong>
                  <small>
                    <time dateTime={item.runAt ?? undefined}>
                      {scheduledTime(item.runAt, item.timeZone, dateFormat)}
                    </time>
                    {!item.queued && ' · awaiting dispatch setup'}
                  </small>
                </div>
              </div>
            ))}
            {data.upcomingTotal > data.upcoming.length && (
              <p className="inspector-data-note">
                Showing the next {data.upcoming.length} of {data.upcomingTotal} schedules.
              </p>
            )}
            <div className="inspector-upcoming-row inspector-review-status">
              <Clock3 size={15} />
              <div>
                <strong>Goal and context review</strong>
                <small>
                  {data.review === null
                    ? 'Scheduler status unavailable'
                    : !data.review.configured
                      ? 'Needs a relevance model'
                      : !data.review.scheduled
                        ? 'Not scheduled in this instance'
                        : data.review.cron === '0 * * * *'
                          ? `Every hour · ${data.review.timeZone ?? 'UTC'}`
                          : `Scheduled · ${data.review.cron} · ${data.review.timeZone}`}
                </small>
              </div>
            </div>
            <p className="inspector-data-note">
              Reviews follow your preferences while Otto is running.
            </p>
          </section>
          <section className={`inspector-work-section${!data.decisions.length ? ' is-empty' : ''}`}>
            <div className="inspector-section-heading">
              <h3>Recent decisions</h3>
              <span>
                {data.decisions.length ? 'Last' : 'None in the last'} {data.decisionWindowHours}{' '}
                hours
              </span>
            </div>
            {data.decisions.map((item) => (
              <div className="inspector-decision" key={item.id}>
                <strong>{item.kind === 'review' ? 'Goal and context review' : 'App update'}</strong>
                <span>
                  {
                    {
                      wake: item.taskId ? 'Follow-up created' : 'Waiting to start',
                      digest: 'Saved for later',
                      ignore: 'No action needed',
                    }[item.decision]
                  }
                </span>
                <p>{item.reason}</p>
                <small>{formatRelativeTime(item.createdAt, dateFormat)}</small>
              </div>
            ))}
            {data.decisionsTotal > data.decisions.length && (
              <p className="inspector-data-note">
                Latest {data.decisions.length} of {data.decisionsTotal} decisions shown.
              </p>
            )}
          </section>
        </>
      )}
    </div>
  );
}
