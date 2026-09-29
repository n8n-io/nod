import { useEffect, useRef, useState } from 'react';
import { ChevronDown, Copy, Check } from 'lucide-react';
import type { InspectorPromptsResponse } from '../../shared/inspector-prompts';
import { api, errorMessage } from '../lib/api';
import { Button, Loading, Notice } from './ui';
import { compactActivityText } from '../lib/inspector-observations';
import { formatDateTime, formatNumber, useDateFormat } from '../lib/date-format';

function PromptText({ label, text }: { label: string; text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <details className="inspector-prompt-text">
      <summary>
        <span className="inspector-prompt-label">
          <ChevronDown size={13} />
          {label}
        </span>
        <small>{formatNumber(text.length)} characters</small>
      </summary>
      <Button
        variant="ghost"
        size="sm"
        onClick={() =>
          void navigator.clipboard
            .writeText(text)
            .then(() => setCopied(true))
            .catch(() => setCopied(false))
        }
      >
        {copied ? <Check size={13} /> : <Copy size={13} />}
        {copied ? 'Copied' : `Copy ${label.toLowerCase()}`}
      </Button>
      <pre>{text}</pre>
    </details>
  );
}

export function InspectorPrompts({ taskId }: { taskId?: string }) {
  return <PromptHistory key={taskId ?? 'all'} taskId={taskId} />;
}

function PromptHistory({ taskId }: { taskId?: string }) {
  const dateFormat = useDateFormat();
  const [data, setData] = useState<InspectorPromptsResponse | null>(null);
  const [error, setError] = useState('');
  const [older, setOlder] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const historyRequest = useRef<AbortController | null>(null);
  useEffect(() => () => historyRequest.current?.abort(), []);
  useEffect(() => {
    if (older) return;
    let stopped = false;
    let pending = false;
    const controller = new AbortController();
    async function refresh() {
      if (pending) return;
      pending = true;
      try {
        const next = await api<InspectorPromptsResponse>(
          '/api/inspector/prompts' + (taskId ? '?taskId=' + encodeURIComponent(taskId) : ''),
          { signal: controller.signal },
        );
        if (stopped) return;
        setData(next);
        setError('');
      } catch (cause) {
        if (!stopped) setError(errorMessage(cause));
      } finally {
        pending = false;
      }
    }
    void refresh();
    const timer = setInterval(() => {
      if (!document.hidden) void refresh();
    }, 5000);
    return () => {
      stopped = true;
      controller.abort();
      clearInterval(timer);
    };
  }, [taskId, older]);
  async function loadEarlier() {
    if (!data?.nextBefore || !data.nextBeforeId || loadingOlder) return;
    const controller = new AbortController();
    historyRequest.current = controller;
    setLoadingOlder(true);
    setOlder(true);
    try {
      const params = new URLSearchParams({
        before: data.nextBefore,
        beforeId: data.nextBeforeId,
        ...(taskId ? { taskId } : {}),
      });
      const next = await api<InspectorPromptsResponse>('/api/inspector/prompts?' + params, {
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      setOlder(true);
      setData((current) => ({
        ...next,
        prompts: [
          ...new Map(
            [...(current?.prompts ?? []), ...next.prompts].map((prompt) => [prompt.id, prompt]),
          ).values(),
        ],
      }));
      setError('');
    } catch (cause) {
      if (!controller.signal.aborted) setError(errorMessage(cause));
    } finally {
      if (!controller.signal.aborted) setLoadingOlder(false);
    }
  }
  return (
    <div className="inspector-prompts">
      <p className="inspector-data-note">
        Effective instructions and context. Private, redacted, retained for seven days.
      </p>
      {error && <Notice>{error}</Notice>}
      {!data && !error && <Loading label="Loading prompts…" />}
      {older && (
        <Button variant="ghost" size="sm" disabled={loadingOlder} onClick={() => setOlder(false)}>
          Back to latest prompts
        </Button>
      )}
      {Boolean(data?.dropped) && (
        <Notice kind="info">Some prompt snapshots could not be recorded.</Notice>
      )}
      {data?.prompts.length === 0 && (
        <p className="muted">Prompts appear when the agent next runs.</p>
      )}
      {data?.prompts.map((prompt) => (
        <section className="inspector-prompt" key={prompt.id}>
          <header className="inspector-prompt-heading">
            <span>
              <strong>{compactActivityText(prompt.title, 90)}</strong>
              <small>
                {formatDateTime(prompt.createdAt, dateFormat)} · {prompt.provider} / {prompt.model}
              </small>
            </span>
          </header>
          <div className="inspector-prompt-body">
            <p className="inspector-data-note">
              {prompt.resumed
                ? 'Continued session. The provider also receives its saved transcript.'
                : 'New session.'}{' '}
              {prompt.imageCount
                ? `${prompt.imageCount} attached images; image bytes are omitted.`
                : ''}
            </p>
            <PromptText label="System instructions" text={prompt.system} />
            <PromptText label="Latest instruction" text={prompt.instruction} />
          </div>
        </section>
      ))}
      {data?.hasOlder && (
        <Button
          variant="ghost"
          size="sm"
          disabled={loadingOlder}
          onClick={() => void loadEarlier()}
        >
          Load earlier prompts
        </Button>
      )}
    </div>
  );
}
