import { useId, useMemo } from 'react';
import { ChevronDown } from './icons';
import type { FeedbackReport } from '../../shared/feedback';
import { parseFeedbackActivity } from '../../shared/feedback-activity';
import { Button, Checkbox } from './ui';

type ReportRecord = Record<string, unknown>;

function record(value: unknown): ReportRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as ReportRecord)
    : null;
}

function rows(value: unknown) {
  return Array.isArray(value) ? value.map(record).filter((row) => row !== null) : [];
}

function label(value: unknown, fallback: string) {
  if (typeof value !== 'string' || !value.trim()) return fallback;
  const words = value.replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2');
  return words[0].toUpperCase() + words.slice(1).toLowerCase();
}

export function feedbackReportData(content: string) {
  try {
    const data = record(JSON.parse(content));
    const coverage = record(data?.coverage);
    return data?.format === 'nod-feedback-report-v3' &&
      ((coverage?.contentIncluded === true && coverage.redaction === 'best-effort') ||
        (coverage?.contentIncluded === false && coverage.redaction === 'unavailable'))
      ? data
      : null;
  } catch {
    return null;
  }
}

function Status({ value }: { value: unknown }) {
  const status = typeof value === 'string' ? value : 'unknown';
  return (
    <span className="feedback-diagnostics-status" data-status={status}>
      {status === 'succeeded' ? 'Completed' : label(status, 'Unknown')}
    </span>
  );
}

export function FeedbackDiagnostics({
  included,
  report,
  preview,
  loading,
  error,
  frozen,
  onToggleIncluded,
  onReview,
  onRefresh,
}: {
  included: boolean;
  report: FeedbackReport | null;
  preview: boolean;
  loading: boolean;
  error: string;
  frozen: boolean;
  onToggleIncluded(): void;
  onReview(): void;
  onRefresh(): void;
}) {
  const previewId = useId();
  const data = useMemo(() => (report ? feedbackReportData(report.content) : null), [report]);
  const messages = rows(data?.messages);
  const turns = rows(data?.turns).reverse();
  const execution = rows(data?.execution).reverse();
  const logs = rows(data?.logs).reverse();
  const toolEvents = logs.filter(
    (entry) => entry.event === 'tool_start' || entry.event === 'tool_end',
  );
  const failures = [
    ...logs.filter((entry) => entry.event !== 'tool_start' && entry.event !== 'tool_end'),
    ...rows(data?.clientErrors).reverse(),
  ];
  const connections: ReportRecord[] = [
    ...rows(data?.connections),
    ...rows(data?.browserConnections),
    ...rows(data?.directConnections).map((connection) => ({
      ...connection,
      method: 'direct',
      status: connection.reconnectRequired
        ? 'reconnect'
        : connection.replaced
          ? 'replaced'
          : 'configured',
    })),
    ...rows(data?.modelConnections),
  ];
  const activity = parseFeedbackActivity(record(data?.appActivity)?.entries).reverse();
  const coverage = record(data?.coverage);
  const sections = record(coverage?.sections);
  const unavailable = Object.values(sections ?? {}).some(
    (section) => record(section)?.status === 'unavailable',
  );

  return (
    <section className="feedback-diagnostics" aria-label="Diagnostic report">
      <div className="feedback-diagnostics-heading">
        <label>
          <Checkbox checked={included} disabled={frozen} onChange={onToggleIncluded} />
          <span>Include diagnostic report</span>
        </label>
        {included && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="feedback-diagnostics-review"
            disabled={!report && (loading || frozen)}
            onClick={onReview}
            aria-expanded={!!(preview && data)}
            aria-controls={preview && data ? previewId : undefined}
          >
            {loading ? 'Preparing…' : preview ? 'Hide' : 'Review'}
            <ChevronDown size={14} aria-hidden="true" />
          </Button>
        )}
      </div>
      <p className="feedback-diagnostics-disclosure">
        Recent messages, tool inputs and results, logs and app activity help us fix bugs and improve
        nod. Known secrets and personal details are masked. Redaction can miss information; review
        before sending or uncheck to leave the report out.
      </p>
      {included && error && (
        <div className="feedback-diagnostics-error" role="alert">
          <span>{error}</span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={loading || frozen}
            onClick={onRefresh}
          >
            Try again
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={frozen}
            onClick={onToggleIncluded}
          >
            Continue without report
          </Button>
        </div>
      )}
      {included && preview && report && (
        <div id={previewId} className="feedback-diagnostics-preview">
          {data ? (
            <>
              <p className="feedback-diagnostics-snapshot">
                {messages.length} {messages.length === 1 ? 'message' : 'messages'}, {turns.length}{' '}
                {turns.length === 1 ? 'request' : 'requests'}, {execution.length} agent{' '}
                {execution.length === 1 ? 'event' : 'events'} and {connections.length}{' '}
                {connections.length === 1 ? 'connection' : 'connections'}
                {typeof coverage?.hours === 'number'
                  ? ` from the last ${coverage.hours} hours.`
                  : '.'}
                {coverage?.truncated === true ? ' Some older activity was omitted.' : ''}
                {unavailable ? ' Some diagnostics are unavailable.' : ''}
                {coverage?.redaction === 'unavailable'
                  ? ' Message content and logs were omitted because redaction was unavailable.'
                  : ''}
              </p>
              <details className="feedback-diagnostics-section feedback-diagnostics-raw">
                <summary>
                  <span>Messages ({messages.length})</span>
                  <ChevronDown size={14} aria-hidden="true" />
                </summary>
                <div className="feedback-diagnostics-items">
                  {messages.map((message, index) => (
                    <div key={index}>
                      <div className="feedback-diagnostics-activity">
                        <span>{label(message.role, 'Message')}</span>
                        <span>{String(message.turnId ?? '')}</span>
                      </div>
                      <pre>
                        {typeof message.text === 'string' ? message.text : '[content omitted]'}
                      </pre>
                    </div>
                  ))}
                </div>
              </details>
              {[
                { title: 'Tool inputs and results', entries: toolEvents },
                { title: 'Recent logs', entries: failures },
              ].map(({ title, entries }) => (
                <details
                  className="feedback-diagnostics-section feedback-diagnostics-raw"
                  key={title}
                >
                  <summary>
                    <span>
                      {title} ({entries.length})
                    </span>
                    <ChevronDown size={14} aria-hidden="true" />
                  </summary>
                  <div className="feedback-diagnostics-items">
                    {entries.map((entry, index) => (
                      <details key={index}>
                        <summary>
                          <span>
                            {label(
                              record(entry.data)?.tool,
                              label(record(entry.data)?.event, label(entry.event, 'Event')),
                            )}
                            {entry.event === 'tool_start'
                              ? ' · Input'
                              : record(entry.data)?.status
                                ? ` · ${label(record(entry.data)?.status, 'Result')}`
                                : ''}{' '}
                            · {String(entry.callId ?? entry.turnId ?? '')}
                          </span>
                          <span>{Math.round(Number(entry.ageMs ?? 0) / 1000)} s ago</span>
                        </summary>
                        <pre>{JSON.stringify(entry, null, 2)}</pre>
                      </details>
                    ))}
                    {!entries.length && (
                      <p className="feedback-diagnostics-empty">No recent entries.</p>
                    )}
                  </div>
                </details>
              ))}
              <details className="feedback-diagnostics-section">
                <summary>
                  <span>Chat and agent activity</span>
                  <ChevronDown size={14} aria-hidden="true" />
                </summary>
                <div className="feedback-diagnostics-items">
                  {turns.map((turn, index) => (
                    <div className="feedback-diagnostics-activity" key={`turn-${index}`}>
                      <span>
                        {label(turn.source, 'Request')}
                        {typeof turn.durationMs === 'number'
                          ? ` · ${(turn.durationMs / 1000).toFixed(1)} s`
                          : ''}
                      </span>
                      <Status value={turn.status} />
                    </div>
                  ))}
                  {execution.map((event, index) => (
                    <div className="feedback-diagnostics-activity" key={`event-${index}`}>
                      <span>{label(event.tool, 'Agent')}</span>
                      <span>{label(event.type, 'Activity')}</span>
                    </div>
                  ))}
                  {!turns.length && !execution.length && (
                    <p className="feedback-diagnostics-empty">No recent agent activity.</p>
                  )}
                </div>
              </details>
              <details className="feedback-diagnostics-section">
                <summary>
                  <span>Connections</span>
                  <ChevronDown size={14} aria-hidden="true" />
                </summary>
                <div className="feedback-diagnostics-items">
                  {connections.map((connection, index) => (
                    <div className="feedback-diagnostics-activity" key={index}>
                      <span>
                        {label(
                          connection.app,
                          label(connection.provider, label(connection.method, 'Connection')),
                        )}
                      </span>
                      <Status value={connection.status} />
                    </div>
                  ))}
                  {!connections.length && (
                    <p className="feedback-diagnostics-empty">No connections in this report.</p>
                  )}
                </div>
              </details>
              <details className="feedback-diagnostics-section">
                <summary>
                  <span>App activity</span>
                  <ChevronDown size={14} aria-hidden="true" />
                </summary>
                <div className="feedback-diagnostics-items">
                  {activity.map((event, index) => {
                    const properties = event.properties;
                    const context = label(
                      properties.app,
                      label(properties.area, label(properties.provider, 'App')),
                    );
                    const title =
                      event.event === 'screen'
                        ? `Opened ${label(String(properties.screen ?? '').slice(1), 'Chat')}`
                        : event.event === 'request_failed'
                          ? `${context} request failed`
                          : event.event === 'nod_ui_error'
                            ? `${context} error`
                            : event.event === 'nod_service_used'
                              ? `${context} action`
                              : `${context} connection`;
                    const details = [
                      properties.status ?? properties.outcome,
                      properties.failure_reason ?? properties.reason,
                      properties.action,
                    ]
                      .filter((value) => value !== undefined)
                      .map((value) => label(String(value), ''))
                      .join(' · ');
                    return (
                      <div className="feedback-diagnostics-activity" key={index}>
                        <span>
                          {title}
                          {details ? ` · ${details}` : ''}
                        </span>
                        <span>{Math.round(event.ageMs / 1000)} s ago</span>
                      </div>
                    );
                  })}
                  {!activity.length && (
                    <p className="feedback-diagnostics-empty">No recent app activity.</p>
                  )}
                </div>
              </details>
              <details className="feedback-diagnostics-section feedback-diagnostics-raw">
                <summary>
                  <span>Full report</span>
                  <ChevronDown size={14} aria-hidden="true" />
                </summary>
                <pre aria-label="Diagnostic report">{report.content}</pre>
              </details>
            </>
          ) : (
            <p className="feedback-diagnostics-snapshot" role="alert">
              This report cannot be shared safely. Refresh it or continue without a report.
            </p>
          )}
        </div>
      )}
    </section>
  );
}
