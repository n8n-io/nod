import { useId, useMemo, useState } from 'react';
import { ChevronDown, Code, Download } from './icons';
import type { FeedbackReport } from '../../shared/feedback';
import { parseFeedbackActivity } from '../../shared/feedback-activity';
import { integrationMetadata } from '../../shared/integrations';
import { Button, Checkbox } from './ui';
import { Tabs } from './tabs';

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
  const status = typeof value === 'string' || typeof value === 'number' ? String(value) : 'unknown';
  return (
    <span className="feedback-diagnostics-status" data-status={status}>
      {status === 'succeeded' ? 'Completed' : label(status, 'Unknown')}
    </span>
  );
}

function ReportValue({ value, depth = 0 }: { value: unknown; depth?: number }) {
  if (value === null || value === undefined) return <span>Not recorded</span>;
  if (typeof value === 'boolean') return <span>{value ? 'Yes' : 'No'}</span>;
  if (typeof value !== 'object')
    return <span className="feedback-diagnostics-value">{String(value)}</span>;
  if (depth >= 6)
    return (
      <span className="feedback-diagnostics-empty">See the full report for nested details.</span>
    );
  if (Array.isArray(value))
    return value.length ? (
      <ul className="feedback-diagnostics-values">
        {value.map((item, index) => (
          <li key={index}>
            <ReportValue value={item} depth={depth + 1} />
          </li>
        ))}
      </ul>
    ) : (
      <span>None</span>
    );
  const fields = Object.entries(value);
  return fields.length ? (
    <dl className="feedback-diagnostics-fields">
      {fields.map(([name, item]) => (
        <div key={name}>
          <dt>{label(name, 'Detail')}</dt>
          <dd>
            <ReportValue value={item} depth={depth + 1} />
          </dd>
        </div>
      ))}
    </dl>
  ) : (
    <span>No details</span>
  );
}

function reportDetails(entry: unknown) {
  const data = record(entry);
  return Object.entries(record(data?.data) ?? data ?? {}).filter(
    ([name]) =>
      ![
        'id',
        'turnId',
        'sessionId',
        'runId',
        'parentRunId',
        'callId',
        'messageId',
        'at',
        'createdAt',
        'ageMs',
        'tool',
        'event',
        'type',
        'status',
        'app',
        'provider',
        'source',
        'channel',
      ].includes(name),
  );
}

function reportLogs(data: ReportRecord | null) {
  const entries: ReportRecord[] = [];
  const starts = new Map<string, number>();
  for (const entry of [...rows(data?.logs), ...rows(data?.clientErrors)]) {
    const key = typeof entry.callId === 'string' ? `${entry.turnId ?? ''}:${entry.callId}` : null;
    const index = key ? starts.get(key) : undefined;
    if (entry.event === 'tool_end' && index !== undefined) {
      entries[index] = {
        ...entries[index],
        ...entry,
        data: { ...record(entries[index]?.data), ...record(entry.data) },
      };
      starts.delete(key!);
    } else {
      if (entry.event === 'tool_start' && key) starts.set(key, entries.length);
      entries.push(entry);
    }
  }
  return entries.reverse();
}

function ReportEntry({
  title,
  description,
  status,
  entry,
}: {
  title: string;
  description?: unknown;
  status?: unknown;
  entry: unknown;
}) {
  const details = reportDetails(entry);
  const Container = details.length ? 'details' : 'div';
  const Heading = details.length ? 'summary' : 'div';
  return (
    <Container className="feedback-diagnostics-entry">
      <Heading className="feedback-diagnostics-entry-heading">
        <span>
          <strong>{title}</strong>
          {typeof description === 'string' && description && <span>{description}</span>}
        </span>
        {status !== undefined && <Status value={status} />}
        {!!details.length && <ChevronDown size={14} />}
      </Heading>
      {!!details.length && (
        <div className="feedback-diagnostics-details">
          {details.map(([name, value]) => (
            <section key={name}>
              <h4>
                {name === 'output' || name === 'result'
                  ? 'Result'
                  : name === 'prompt'
                    ? 'Request'
                    : name === 'durationMs'
                      ? 'Duration'
                      : label(name, 'Details')}
              </h4>
              <ReportValue
                value={
                  name === 'durationMs' && typeof value === 'number'
                    ? `${(value / 1000).toFixed(1)} seconds`
                    : value
                }
              />
            </section>
          ))}
        </div>
      )}
    </Container>
  );
}

const reportTabs = ['Chat', 'Activity', 'Connections'] as const;

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
  const [tab, setTab] = useState<(typeof reportTabs)[number]>('Chat');
  const data = useMemo(() => (report ? feedbackReportData(report.content) : null), [report]);
  const messages = rows(data?.messages);
  const turns = rows(data?.turns).reverse();
  const execution = rows(data?.execution).reverse();
  const logs = reportLogs(data);
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
  function download() {
    if (!report || !data) return;
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }),
    );
    const link = document.createElement('a');
    link.href = url;
    link.download = 'nod-diagnostic-report.json';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return (
    <section className="feedback-diagnostics" aria-label="Diagnostic report" data-analytics-private>
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
      <p className="feedback-diagnostics-disclosure">Data is anonymized before sending.</p>
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
              <Tabs
                id={previewId}
                panelId={`${previewId}-content`}
                className="feedback-diagnostics-tabs"
                variant="underline"
                label="Report sections"
                value={tab}
                items={reportTabs.map((value) => ({ value, label: value }))}
                onValueChange={setTab}
              />
              {(unavailable || coverage?.redaction === 'unavailable') && (
                <p className="feedback-diagnostics-snapshot">
                  {coverage?.redaction === 'unavailable'
                    ? 'Message content and logs were omitted because redaction was unavailable.'
                    : 'Some diagnostics are unavailable.'}
                </p>
              )}
              <div
                key={tab}
                id={`${previewId}-content`}
                className="feedback-diagnostics-content"
                role="tabpanel"
                aria-labelledby={`${previewId}-${tab}`}
                tabIndex={0}
              >
                {tab === 'Chat' && (
                  <div className="feedback-diagnostics-messages">
                    {messages.map((message, index) => (
                      <div
                        className="feedback-diagnostics-message"
                        key={index}
                        data-role={message.role}
                      >
                        <strong>
                          {message.role === 'assistant'
                            ? 'Nod'
                            : message.role === 'user'
                              ? 'You'
                              : label(message.role, 'Message')}
                        </strong>
                        <p>
                          {typeof message.text === 'string' ? message.text : '[content omitted]'}
                        </p>
                      </div>
                    ))}
                    {!messages.length && (
                      <p className="feedback-diagnostics-empty">
                        No message content in this report.
                      </p>
                    )}
                  </div>
                )}
                {tab === 'Activity' && (
                  <div className="feedback-diagnostics-groups">
                    {!!turns.length && (
                      <section>
                        <h3>Requests</h3>
                        {turns.map((turn, index) => (
                          <ReportEntry
                            key={index}
                            title={label(turn.source ?? turn.channel, 'Request')}
                            description={turn.error}
                            status={turn.status}
                            entry={turn}
                          />
                        ))}
                      </section>
                    )}
                    {!!logs.length && (
                      <section>
                        <h3>Tools and logs</h3>
                        {logs.map((entry, index) => {
                          const details = record(entry.data) ?? entry;
                          return (
                            <ReportEntry
                              key={index}
                              title={label(
                                details.tool,
                                label(details.event, label(entry.event, 'App error')),
                              )}
                              description={details.message ?? record(details.error)?.message}
                              status={
                                entry.event === 'tool_start'
                                  ? 'input'
                                  : entry.event === 'failure'
                                    ? 'failed'
                                    : (details.status ??
                                      (entry.event === 'tool_end' ? 'result' : undefined))
                              }
                              entry={entry}
                            />
                          );
                        })}
                      </section>
                    )}
                    {!!execution.length && (
                      <section>
                        <h3>Agent activity</h3>
                        {execution.map((entry, index) => (
                          <ReportEntry
                            key={index}
                            title={label(entry.tool, 'Agent')}
                            description={label(entry.type ?? entry.event, 'Activity')}
                            entry={entry}
                          />
                        ))}
                      </section>
                    )}
                    {!!activity.length && (
                      <section>
                        <h3>App activity</h3>
                        {activity.map((entry, index) => {
                          const properties = entry.properties;
                          const context = label(
                            properties.app,
                            label(properties.area, label(properties.provider, 'App')),
                          );
                          const title =
                            entry.event === 'screen'
                              ? `Opened ${label(String(properties.screen ?? '').slice(1), 'Chat')}`
                              : entry.event === 'request_failed'
                                ? `${context} request failed`
                                : entry.event === 'ui_error'
                                  ? `${context} error`
                                  : entry.event === 'service_used'
                                    ? `${context} action`
                                    : `${context} connection`;
                          return (
                            <ReportEntry
                              key={index}
                              title={title}
                              status={properties.status ?? properties.outcome}
                              entry={entry}
                            />
                          );
                        })}
                      </section>
                    )}
                    {!turns.length && !logs.length && !execution.length && !activity.length && (
                      <p className="feedback-diagnostics-empty">
                        No recent activity in this report.
                      </p>
                    )}
                  </div>
                )}
                {tab === 'Connections' && (
                  <div className="feedback-diagnostics-connections">
                    {connections.map((connection, index) => (
                      <ReportEntry
                        key={index}
                        title={
                          typeof connection.app === 'string'
                            ? integrationMetadata(connection.app).name
                            : label(connection.provider, label(connection.method, 'Connection'))
                        }
                        status={connection.status}
                        entry={connection}
                      />
                    ))}
                    {!connections.length && (
                      <p className="feedback-diagnostics-empty">No connections in this report.</p>
                    )}
                  </div>
                )}
              </div>
              <div className="feedback-diagnostics-footer">
                <details className="feedback-diagnostics-full">
                  <summary>
                    <Code size={16} />
                    <span>Full report</span>
                    <ChevronDown size={14} />
                  </summary>
                  <pre aria-label="Full diagnostic report">{JSON.stringify(data, null, 2)}</pre>
                </details>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="feedback-diagnostics-download"
                  aria-label="Download report"
                  title="Download report"
                  onClick={download}
                >
                  <Download size={16} /> <span>Download</span>
                </Button>
              </div>
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
