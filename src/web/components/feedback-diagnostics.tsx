import { useId, useMemo } from 'react';
import { ChevronDown } from './icons';
import type { FeedbackReport } from '../../shared/feedback';
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
  const data = useMemo(() => {
    if (!report) return null;
    try {
      const parsed = record(JSON.parse(report.content));
      return parsed?.format === 'nod-feedback-report-v1' ? parsed : null;
    } catch {
      return null;
    }
  }, [report]);
  const messages = rows(data?.messages);
  const turns = rows(data?.turns).reverse();
  const actions = rows(data?.trace).reverse();
  const activityCount = actions.length + turns.length;
  const coverage = record(data?.coverage);
  const contentOmitted = coverage?.contentOmitted === true;

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
            aria-expanded={!!(preview && report)}
            aria-controls={preview && report ? previewId : undefined}
          >
            {loading ? 'Preparing…' : preview ? 'Hide' : 'Review'}
            <ChevronDown size={14} aria-hidden="true" />
          </Button>
        )}
      </div>
      <p
        className="feedback-diagnostics-disclosure"
        role={included && contentOmitted ? 'status' : undefined}
      >
        {included
          ? contentOmitted
            ? 'Conversation and action details are unavailable. You can still send this report.'
            : 'Includes recent chat, actions and their results with your feedback.'
          : 'Optional context to help investigate your feedback.'}
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
                {messages.length} {messages.length === 1 ? 'message' : 'messages'} and{' '}
                {activityCount} {activityCount === 1 ? 'activity entry' : 'activity entries'}
                {typeof coverage?.hours === 'number'
                  ? ` from the last ${coverage.hours} hours.`
                  : '.'}
                {coverage?.truncated === true ? ' Some older details were omitted.' : ''}
              </p>
              <details className="feedback-diagnostics-section">
                <summary>
                  <span>Conversation</span>
                  <ChevronDown size={14} aria-hidden="true" />
                </summary>
                <div className="feedback-diagnostics-items">
                  {messages.length ? (
                    messages.map((message, index) => (
                      <article className="feedback-diagnostics-message" key={index}>
                        <strong>
                          {message.role === 'user'
                            ? 'You'
                            : message.role === 'assistant'
                              ? 'nod'
                              : label(message.role, 'Message')}
                        </strong>
                        <p>
                          {typeof message.text === 'string'
                            ? message.text
                            : contentOmitted
                              ? 'Message text unavailable.'
                              : 'No text recorded.'}
                        </p>
                      </article>
                    ))
                  ) : (
                    <p className="feedback-diagnostics-empty">No recent messages in this report.</p>
                  )}
                </div>
              </details>
              <details className="feedback-diagnostics-section">
                <summary>
                  <span>Activity</span>
                  <ChevronDown size={14} aria-hidden="true" />
                </summary>
                <div className="feedback-diagnostics-items">
                  {actions.map((action, index) => (
                    <div className="feedback-diagnostics-activity" key={`action-${index}`}>
                      <span>{label(action.name, 'Action')}</span>
                      <Status value={action.status} />
                    </div>
                  ))}
                  {turns.map((turn, index) => (
                    <div className="feedback-diagnostics-activity" key={`turn-${index}`}>
                      <span>
                        {turn.source === 'user'
                          ? 'Chat request'
                          : turn.source === 'schedule'
                            ? 'Scheduled task'
                            : turn.source === 'event'
                              ? 'Background update'
                              : 'Continued task'}
                      </span>
                      <Status value={turn.status} />
                    </div>
                  ))}
                  {!actions.length && !turns.length && (
                    <p className="feedback-diagnostics-empty">No recent activity in this report.</p>
                  )}
                </div>
              </details>
            </>
          ) : (
            <p className="feedback-diagnostics-snapshot">
              Open the full report below to review what will be shared.
            </p>
          )}
          <details className="feedback-diagnostics-section feedback-diagnostics-raw">
            <summary>
              <span>Full report</span>
              <ChevronDown size={14} aria-hidden="true" />
            </summary>
            <pre aria-label="Diagnostic report">{report.content}</pre>
          </details>
        </div>
      )}
    </section>
  );
}
