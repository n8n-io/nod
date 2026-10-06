import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import type { TurnEvent } from '../../shared/contracts';
import type {
  InspectorObservationsResponse,
  InspectorToolsResponse,
  ModelUsage,
  ToolCall,
  ToolUsage,
  InspectorTool,
} from '../../shared/inspector';
import { api, errorMessage } from '../lib/api';
import { formatFullDateTime, formatNumber, formatTime } from '../lib/date-format';
import {
  filterToolCalls,
  completeObservationRefresh,
  formatInspectorJson,
  formatModelCost,
  formatToolDuration,
  mergeObservationPage,
  groupTurnActivity,
  type ToolStatusFilter,
} from '../lib/inspector-observations';
import { Button, Loading, Notice, SearchField } from './ui';

const statuses: Array<{ value: ToolStatusFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'failed', label: 'Failed' },
  { value: 'running', label: 'Running' },
];
const counts = { format: (value: number) => formatNumber(value) };

function RecordedJson({ label, value }: { label: string; value: unknown }) {
  return (
    <section className="inspector-payload">
      <h4>{label}</h4>
      <pre tabIndex={0} aria-label={`${label} JSON`}>
        <code>{formatInspectorJson(value)}</code>
      </pre>
    </section>
  );
}

export function ToolCallRecord({ call }: { call: ToolCall }) {
  return (
    <details className={`inspector-record inspector-call-${call.status}`}>
      <summary>
        <ChevronDown size={16} className="inspector-disclosure" />
        <span className="inspector-record-title">
          <strong>{call.name}</strong>
          <small>{formatTime(call.startedAt, undefined, { seconds: true })}</small>
        </span>
        <span className="inspector-record-state">
          <span className={`inspector-status inspector-status-${call.status}`}>{call.status}</span>
          <small>
            {call.status === 'running' ? 'In progress' : formatToolDuration(call.durationMs)}
          </small>
          <small className="inspector-tool-cost">
            {formatModelCost(call.directCostUsd ?? null)}
            {call.directCostUsd != null &&
            (call.pricing === 'sdk_estimate' || call.pricing === 'mixed')
              ? ' estimated'
              : ''}
          </small>
        </span>
      </summary>
      <div className="inspector-record-body">
        <dl className="inspector-record-facts">
          <dt>Started</dt>
          <dd>{formatFullDateTime(call.startedAt)}</dd>
          <dt>Finished</dt>
          <dd>{call.finishedAt ? formatFullDateTime(call.finishedAt) : 'Not recorded'}</dd>
          <dt>Duration</dt>
          <dd>{call.status === 'running' ? 'In progress' : formatToolDuration(call.durationMs)}</dd>
        </dl>
        <p className="inspector-data-note">Private developer data · redacted before storage.</p>
        <p className="inspector-data-note">
          Direct provider cost · {counts.format(call.pricedOperations ?? 0)} of{' '}
          {counts.format(call.providerOperations ?? 0)} operations priced. Assistant model costs are
          separate.
        </p>
        <RecordedJson label="Input" value={call.input} />
        {call.output === null && call.status !== 'succeeded' ? (
          <p className="inspector-empty">
            {call.status === 'running'
              ? 'Waiting for tool output.'
              : 'No tool output was recorded.'}
          </p>
        ) : (
          <RecordedJson label="Output" value={call.output} />
        )}
        {call.error && (
          <section className="inspector-payload inspector-error">
            <h4>Error</h4>
            <pre>{call.error}</pre>
          </section>
        )}
      </div>
    </details>
  );
}

export function ModelUsageSummary({
  summary,
}: {
  summary: InspectorObservationsResponse['summary'];
}) {
  if (!summary.modelRequests)
    return (
      <p className="inspector-empty">
        No model requests recorded yet. Older activity is not backfilled, and expired records are
        removed.
      </p>
    );
  return (
    <section className="inspector-usage-summary" aria-label="Retained model usage">
      <div className="inspector-cost-heading">
        <span>Assistant model requests · SDK estimate</span>
        <strong>{formatModelCost(summary.knownCostUsd)}</strong>
      </div>
      <p className="inspector-data-note">
        USD estimate for recorded assistant model requests. Compaction, cache warming, speech,
        browser-provider, other tool/provider fees, and hosting charges are excluded. This is not an
        invoice total.
      </p>
      {summary.unpricedRequests > 0 && (
        <p className="inspector-unpriced">
          {counts.format(summary.unpricedRequests)} model{' '}
          {summary.unpricedRequests === 1 ? 'request has' : 'requests have'} no price estimate
          {summary.knownCostUsd === null ? '.' : '; the estimate is partial.'}
        </p>
      )}
      <dl className="inspector-usage-grid">
        <div>
          <dt>Tool calls</dt>
          <dd>{counts.format(summary.calls)}</dd>
        </div>
        <div>
          <dt>Model requests</dt>
          <dd>{counts.format(summary.modelRequests)}</dd>
        </div>
        <div>
          <dt>Input tokens</dt>
          <dd>{counts.format(summary.inputTokens)}</dd>
        </div>
        <div>
          <dt>Output tokens</dt>
          <dd>{counts.format(summary.outputTokens)}</dd>
        </div>
        <div>
          <dt>Cache read</dt>
          <dd>{counts.format(summary.cacheReadTokens)}</dd>
        </div>
        <div>
          <dt>Cache write</dt>
          <dd>{counts.format(summary.cacheWriteTokens)}</dd>
        </div>
        <div>
          <dt>Total tokens</dt>
          <dd>{counts.format(summary.totalTokens)}</dd>
        </div>
      </dl>
    </section>
  );
}

export function ModelUsageRecord({ usage }: { usage: ModelUsage }) {
  return (
    <details className="inspector-record">
      <summary>
        <ChevronDown size={16} className="inspector-disclosure" />
        <span className="inspector-record-title">
          <strong>{usage.model}</strong>
          <small>
            {usage.provider} · {formatTime(usage.createdAt, undefined, { seconds: true })}
          </small>
        </span>
        <span className="inspector-record-state">
          <span>{formatModelCost(usage.costSource === 'sdk_estimate' ? usage.costUsd : null)}</span>
          <small>{counts.format(usage.totalTokens)} tokens</small>
        </span>
      </summary>
      <div className="inspector-record-body">
        <p className="inspector-data-note">
          {usage.costSource === 'sdk_estimate'
            ? 'Model request estimate from the SDK, in USD. Not a tool-call charge.'
            : 'No SDK price estimate is available for this assistant model request.'}
        </p>
        <dl className="inspector-usage-grid">
          <div>
            <dt>Input tokens</dt>
            <dd>{counts.format(usage.inputTokens)}</dd>
          </div>
          <div>
            <dt>Output tokens</dt>
            <dd>{counts.format(usage.outputTokens)}</dd>
          </div>
          <div>
            <dt>Cache read</dt>
            <dd>{counts.format(usage.cacheReadTokens)}</dd>
          </div>
          <div>
            <dt>Cache write</dt>
            <dd>{counts.format(usage.cacheWriteTokens)}</dd>
          </div>
          <div>
            <dt>Total tokens</dt>
            <dd>{counts.format(usage.totalTokens)}</dd>
          </div>
        </dl>
      </div>
    </details>
  );
}

function useInspectorObservations(turnId?: string, tool?: string) {
  const [observations, setObservations] = useState<InspectorObservationsResponse | null>(null);
  const [observationError, setObservationError] = useState('');
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const busy = useRef(false);
  const observationsRef = useRef<InspectorObservationsResponse | null>(null);
  const loadedEarlier = useRef(false);
  const controller = useRef<AbortController | null>(null);

  useEffect(() => {
    const request = new AbortController();
    controller.current = request;
    let timer: ReturnType<typeof setTimeout>;
    loadedEarlier.current = false;
    observationsRef.current = null;
    busy.current = false;
    setObservations(null);
    setObservationError('');
    setLoadingEarlier(false);
    setRefreshing(false);
    async function refresh() {
      if (request.signal.aborted) return;
      if (document.hidden || busy.current) {
        timer = setTimeout(() => void refresh(), 2500);
        return;
      }
      busy.current = true;
      setRefreshing(true);
      try {
        const next = await api<InspectorObservationsResponse>(
          `/api/inspector/observations?${new URLSearchParams({ ...(turnId ? { turnId } : {}), ...(tool ? { tool } : {}) })}`,
          { signal: request.signal },
        );
        if (request.signal.aborted) return;
        const current = observationsRef.current;
        const result =
          current && loadedEarlier.current
            ? await completeObservationRefresh(
                current,
                next,
                async (cursor) => {
                  const params = new URLSearchParams({
                    ...(turnId ? { turnId } : {}),
                    before: cursor.before,
                    ...(tool ? { tool } : {}),
                  });
                  if (cursor.beforeId) params.set('beforeId', cursor.beforeId);
                  return api<InspectorObservationsResponse>(
                    `/api/inspector/observations?${params}`,
                    { signal: request.signal },
                  );
                },
                request.signal,
              )
            : { data: next, reset: true };
        if (request.signal.aborted) return;
        if (result.reset) loadedEarlier.current = false;
        observationsRef.current = result.data;
        setObservations(result.data);
        setObservationError('');
      } catch (cause) {
        if (!request.signal.aborted) setObservationError(errorMessage(cause));
      } finally {
        if (!request.signal.aborted) {
          busy.current = false;
          setRefreshing(false);
          timer = setTimeout(() => void refresh(), 2500);
        }
      }
    }
    void refresh();
    return () => {
      request.abort();
      clearTimeout(timer);
    };
  }, [turnId, tool]);

  async function loadEarlier() {
    if (!observations?.hasOlder || !observations.nextBefore || busy.current) return;
    const request = controller.current;
    if (!request || request.signal.aborted) return;
    busy.current = true;
    setLoadingEarlier(true);
    const params = new URLSearchParams({
      ...(turnId ? { turnId } : {}),
      before: observations.nextBefore,
      ...(tool ? { tool } : {}),
    });
    if (observations.nextBeforeId) params.set('beforeId', observations.nextBeforeId);
    try {
      const next = await api<InspectorObservationsResponse>(
        `/api/inspector/observations?${params}`,
        { signal: request.signal },
      );
      if (request.signal.aborted) return;
      loadedEarlier.current = true;
      const current = observationsRef.current;
      const merged = current ? mergeObservationPage(current, next, 'older') : next;
      observationsRef.current = merged;
      setObservations(merged);
      setObservationError('');
    } catch (cause) {
      if (!request.signal.aborted) setObservationError(errorMessage(cause));
    } finally {
      if (!request.signal.aborted) {
        busy.current = false;
        setLoadingEarlier(false);
      }
    }
  }

  return { observations, observationError, loadingEarlier, refreshing, loadEarlier };
}

function ToolDrilldown({
  turnId,
  usage,
  definition,
  status,
}: {
  turnId?: string;
  usage: ToolUsage;
  definition?: InspectorTool;
  status: ToolStatusFilter;
}) {
  const { observations, observationError, loadingEarlier, refreshing, loadEarlier } =
    useInspectorObservations(turnId, usage.name);
  const [query, setQuery] = useState('');
  const calls = useMemo(
    () => filterToolCalls(observations?.calls ?? [], query, status),
    [observations, query, status],
  );
  return (
    <div className="inspector-tool-drilldown">
      {definition && <p className="inspector-tool-description">{definition.description}</p>}
      <SearchField
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Search loaded inputs, outputs and errors"
        aria-label={`Search ${usage.name} calls`}
      />
      {observationError && <Notice>{observationError}</Notice>}
      {!observations && !observationError && <Loading label="Loading calls…" />}
      {observations && (
        <>
          <p className="inspector-data-note">
            {counts.format(observations.calls.length)} of{' '}
            {counts.format(
              observations.toolUsage.find((row) => row.name === usage.name)?.calls ?? usage.calls,
            )}{' '}
            calls loaded
            {calls.length !== observations.calls.length
              ? ` · ${calls.length} match the filters`
              : ''}
            . Search applies to loaded payloads.
          </p>
          <div className="inspector-record-list">
            {calls.map((call) => (
              <ToolCallRecord key={call.id} call={call} />
            ))}
          </div>
          {!calls.length && <p className="inspector-empty">No loaded calls match the filters.</p>}
          {observations.hasOlder && (
            <Button
              variant="outline"
              size="sm"
              disabled={loadingEarlier || refreshing}
              onClick={() => void loadEarlier()}
            >
              {loadingEarlier ? 'Loading…' : 'Load earlier calls'}
            </Button>
          )}
        </>
      )}
      {definition && (
        <details className="inspector-schema">
          <summary>Input schema</summary>
          <RecordedJson label="Input schema" value={definition.parameters} />
        </details>
      )}
    </div>
  );
}

function ToolUsageFacts({ usage }: { usage: ToolUsage }) {
  return (
    <div className="inspector-tool-facts">
      <span>
        {usage.failed ? `${counts.format(usage.failed)} failed` : 'No failures'}
        {usage.running ? ` · ${counts.format(usage.running)} running` : ''}
      </span>
      <span>
        {usage.averageDurationMs === null
          ? 'Duration unavailable'
          : `${formatToolDuration(usage.averageDurationMs)} average · ${formatToolDuration(usage.maxDurationMs)} longest`}
      </span>
      {usage.cancelled + usage.interrupted > 0 && (
        <span>
          {usage.cancelled} cancelled · {usage.interrupted} interrupted
        </span>
      )}
      {usage.durationSamples > 0 && usage.durationSamples < usage.calls && (
        <span>
          Duration recorded for {counts.format(usage.durationSamples)} of{' '}
          {counts.format(usage.calls)} calls
        </span>
      )}
      <span className="inspector-tool-cost">
        {formatModelCost(usage.directCostUsd ?? null)}
        {usage.directCostUsd != null &&
        (usage.pricing === 'sdk_estimate' || usage.pricing === 'mixed')
          ? ' estimated'
          : ''}
        {(usage.providerOperations ?? 0) > 0 &&
          ` · ${counts.format(usage.pricedOperations ?? 0)}/${counts.format(usage.providerOperations ?? 0)} operations priced`}
      </span>
    </div>
  );
}

export function ToolUsageGroup({
  turnId,
  usage,
  definition,
  status = 'all',
}: {
  turnId?: string;
  usage: ToolUsage;
  definition?: InspectorTool;
  status?: ToolStatusFilter;
}) {
  const [open, setOpen] = useState(false);
  return (
    <details
      className={`inspector-tool-group${usage.failed ? ' inspector-tool-has-failures' : ''}`}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        <ChevronDown size={16} className="inspector-disclosure" />
        <span className="inspector-tool-group-title">
          <strong>{usage.name}</strong>
          <ToolUsageFacts usage={usage} />
        </span>
        <span className="inspector-tool-call-count">
          <strong>{counts.format(usage.calls)}</strong>
          <small>{usage.calls === 1 ? 'call' : 'calls'}</small>
        </span>
      </summary>
      {open && (
        <ToolDrilldown turnId={turnId} usage={usage} definition={definition} status={status} />
      )}
    </details>
  );
}

export function InspectorTools({ turnId }: { turnId?: string }) {
  const [catalog, setCatalog] = useState<InspectorToolsResponse | null>(null);
  const [catalogError, setCatalogError] = useState('');
  const [catalogAttempt, setCatalogAttempt] = useState(0);
  const [view, setView] = useState<'calls' | 'tools' | 'catalog'>('calls');
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<ToolStatusFilter>('all');
  const { observations, observationError, loadingEarlier, refreshing, loadEarlier } =
    useInspectorObservations(turnId);
  useEffect(() => {
    const request = new AbortController();
    setCatalogError('');
    void api<InspectorToolsResponse>('/api/inspector/tools', { signal: request.signal })
      .then((next) => {
        if (!request.signal.aborted) setCatalog(next);
      })
      .catch((cause) => {
        if (!request.signal.aborted) setCatalogError(errorMessage(cause));
      });
    return () => request.abort();
  }, [catalogAttempt]);
  const search = query.trim().toLocaleLowerCase();
  const tools =
    catalog?.tools.filter(
      (tool) =>
        !search ||
        [tool.name, tool.description].some((text) => text.toLocaleLowerCase().includes(search)),
    ) ?? [];
  const usage =
    observations?.toolUsage.filter(
      (tool) =>
        (!search ||
          tool.name.toLocaleLowerCase().includes(search) ||
          tools.some((definition) => definition.name === tool.name)) &&
        (status === 'all' || tool[status] > 0),
    ) ?? [];
  const calls = filterToolCalls(observations?.calls ?? [], query, status);
  return (
    <div className="inspector-tools">
      <div className="inspector-section-heading">
        <h3>Tools</h3>
        <span>{turnId ? 'Message activity' : 'All activity'} · 7 days</span>
      </div>
      <div className="inspector-view-switch" role="group" aria-label="Tool views">
        {(
          [
            ['calls', 'Recent calls'],
            ['tools', 'By tool'],
            ['catalog', 'Available tools'],
          ] as const
        ).map(([value, label]) => (
          <button
            type="button"
            key={value}
            aria-pressed={view === value}
            onClick={() => {
              setView(value);
              setQuery('');
            }}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="inspector-tool-filters">
        <SearchField
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={view === 'calls' ? 'Search loaded calls' : 'Find a tool'}
          aria-label={view === 'calls' ? 'Search loaded calls' : 'Find a tool'}
        />
        {view !== 'catalog' && (
          <div className="inspector-scope-toggle" role="group" aria-label="Tool call status">
            {statuses.map((item) => (
              <button
                key={item.value}
                type="button"
                aria-pressed={status === item.value}
                onClick={() => setStatus(item.value)}
              >
                {item.label}
              </button>
            ))}
          </div>
        )}
      </div>
      {view !== 'catalog' && (
        <>
          {observationError && <Notice>{observationError}</Notice>}
          {!observations && !observationError && <Loading label="Loading recordings…" />}
          {observations && (
            <>
              <p className="inspector-data-note">
                {counts.format(observations.summary.calls)}{' '}
                {observations.summary.calls === 1 ? 'call' : 'calls'} across{' '}
                {observations.toolUsage.length}{' '}
                {observations.toolUsage.length === 1 ? 'tool' : 'tools'}.
                {view === 'calls' &&
                  ` ${counts.format(observations.calls.length)} ${observations.calls.length === 1 ? 'call' : 'calls'} loaded; search applies to loaded payloads.`}
              </p>
              {view === 'calls' ? (
                <>
                  <div className="inspector-record-list">
                    {calls.map((call) => (
                      <ToolCallRecord key={call.id} call={call} />
                    ))}
                  </div>
                  {!calls.length && (
                    <p className="inspector-empty">
                      {observations.summary.calls
                        ? 'No loaded calls match these filters.'
                        : 'No calls recorded yet. Older activity is not backfilled.'}
                    </p>
                  )}
                  {observations.hasOlder && (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={loadingEarlier || refreshing}
                      onClick={() => void loadEarlier()}
                    >
                      {loadingEarlier ? 'Loading…' : 'Load earlier calls'}
                    </Button>
                  )}
                </>
              ) : (
                <>
                  <div className="inspector-tool-groups">
                    {usage.map((row) => (
                      <ToolUsageGroup
                        key={row.name}
                        turnId={turnId}
                        usage={row}
                        definition={catalog?.tools.find((tool) => tool.name === row.name)}
                        status={status}
                      />
                    ))}
                  </div>
                  {!usage.length && (
                    <p className="inspector-empty">No tools match these filters.</p>
                  )}
                </>
              )}
            </>
          )}
        </>
      )}
      {view === 'catalog' && (
        <section className="inspector-catalog-list" aria-label="Available tools">
          <p className="inspector-data-note">
            {catalog?.tools.length ?? '…'} registered tools, including those with no recorded calls.
          </p>
          {catalogError && (
            <>
              <Notice>{catalogError}</Notice>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setCatalogAttempt((value) => value + 1)}
              >
                Retry tool definitions
              </Button>
            </>
          )}
          {!catalog && !catalogError && <Loading label="Loading tool definitions…" />}
          {tools.map((tool) => (
            <section className="inspector-catalog-tool" key={tool.name}>
              <h4>{tool.name}</h4>
              <p className="inspector-tool-description">{tool.description}</p>
              <details className="inspector-schema">
                <summary>Input schema</summary>
                <RecordedJson label="Input schema" value={tool.parameters} />
              </details>
            </section>
          ))}
          {catalog && !tools.length && (
            <p className="inspector-empty">No registered tools match this search.</p>
          )}
        </section>
      )}
      {catalog && (
        <p className="inspector-data-note inspector-capture-note">
          {catalog.captureEnabled ? 'Capture enabled' : 'Capture disabled'} · private developer data
          · {catalog.retentionDays}-day retention ·{' '}
          {counts.format(catalog.payloadLimitBytes / 1024)} KiB per payload. Payloads are redacted;
          images are omitted.
        </p>
      )}
    </div>
  );
}

export function InspectorModels({ turnId }: { turnId?: string }) {
  const { observations, observationError, loadingEarlier, refreshing, loadEarlier } =
    useInspectorObservations(turnId);
  return (
    <section className="inspector-models inspector-tools" aria-label="Assistant model requests">
      <div className="inspector-section-heading">
        <h3>Model requests</h3>
        <span>{turnId ? 'Message activity' : 'All activity'} · 7 days</span>
      </div>
      {observationError && <Notice>{observationError}</Notice>}
      {!observations && !observationError && <Loading label="Loading model requests…" />}
      {observations && (
        <>
          <ModelUsageSummary summary={observations.summary} />
          <div className="inspector-record-list">
            {observations.usage.map((row) => (
              <ModelUsageRecord key={row.id} usage={row} />
            ))}
          </div>
          {observations.hasOlder && (
            <Button
              variant="outline"
              size="sm"
              disabled={loadingEarlier || refreshing}
              onClick={() => void loadEarlier()}
            >
              {loadingEarlier ? 'Loading…' : 'Load earlier model requests'}
            </Button>
          )}
        </>
      )}
    </section>
  );
}

export function InspectorActivity({ turnId, events }: { turnId?: string; events: TurnEvent[] }) {
  const { observations, observationError, loadingEarlier, refreshing, loadEarlier } =
    useInspectorObservations(turnId);
  const items = groupTurnActivity(
    events,
    observations && observations.summary.calls > 0 ? observations.calls : undefined,
    observations?.failures,
  );
  const labels = {
    running: 'In progress',
    succeeded: 'Completed',
    failed: 'Failed',
    cancelled: 'Cancelled',
    interrupted: 'Interrupted',
    info: '',
  };
  return (
    <section className="inspector-section inspector-activity">
      <div className="inspector-section-heading">
        <h3>Recent actions</h3>
        <span>{turnId ? 'Message activity' : 'All activity'}</span>
      </div>
      {observationError && (
        <p className="inspector-data-note">
          Call recordings are temporarily unavailable. Showing the turn timeline.
        </p>
      )}
      {items.length ? (
        <ol className="event-list">
          {items.map((item) => (
            <li key={item.id} className={`activity-${item.status}`}>
              <span className="event-dot" />
              <div>
                <p>{item.title}</p>
                <small>
                  <time dateTime={item.startedAt}>
                    {formatTime(item.startedAt, undefined, { seconds: true })}
                  </time>
                  {labels[item.status] && ` · ${labels[item.status]}`}
                  {item.durationMs !== null && ` · ${formatToolDuration(item.durationMs)}`}
                </small>
                {item.diagnostic !== undefined && (
                  <details className="inspector-record">
                    <summary>Private failure details</summary>
                    <div className="inspector-record-body">
                      <p className="inspector-data-note">
                        Redacted developer data · seven-day retention.
                      </p>
                      <RecordedJson label="Failure diagnostic" value={item.diagnostic} />
                    </div>
                  </details>
                )}
              </div>
            </li>
          ))}
        </ol>
      ) : (
        <p className="inspector-empty">No actions recorded for this turn yet.</p>
      )}
      {observations?.hasOlder && (
        <Button
          variant="outline"
          size="sm"
          disabled={loadingEarlier || refreshing}
          onClick={() => void loadEarlier()}
        >
          {loadingEarlier ? 'Loading…' : 'Load earlier actions'}
        </Button>
      )}
    </section>
  );
}
