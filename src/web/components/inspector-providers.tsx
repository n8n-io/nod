import { useEffect, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import type { ProviderUsageResponse, ProviderUsageSummary } from '../../shared/provider-usage';
import { api, errorMessage } from '../lib/api';
import { formatModelCost, formatToolDuration } from '../lib/inspector-observations';
import { groupProviderUsage, operationLabel, summarizeProviderUsage } from '../lib/provider-usage';
import { Loading, Notice } from './ui';
import { formatNumber } from '../lib/date-format';

const count = { format: (value: number) => formatNumber(value, { maximumFractionDigits: 2 }) };
const pricingLabels = {
  reported: 'Reported cost',
  sdk_estimate: 'SDK estimate',
  mixed: 'Reported cost + SDK estimates',
  unavailable: 'Price unavailable',
};

export function ProviderUsageRow({ usage }: { usage: ProviderUsageSummary }) {
  const metrics = [
    ['Input tokens', usage.inputTokens],
    ['Output tokens', usage.outputTokens],
    ['Cache read tokens', usage.cacheReadTokens],
    ['Cache write tokens', usage.cacheWriteTokens],
    ['Audio seconds', usage.audioSeconds],
    ['Characters', usage.characters],
    ['Messages', usage.messages],
    ['Bytes', usage.bytes],
  ] as const;
  const priced =
    usage.pricing !== 'unavailable' && usage.pricedRequests > 0 && usage.costUsd !== null;
  return (
    <details className="inspector-provider-operation">
      <summary>
        <ChevronDown size={16} className="inspector-disclosure" />
        <span className="inspector-provider-name">
          <strong>{operationLabel(usage.operation)}</strong>
          <small>{usage.model ?? usage.category}</small>
        </span>
        <span className="inspector-provider-total">
          <strong>
            {priced
              ? `${formatModelCost(usage.costUsd)}${usage.pricing === 'sdk_estimate' ? ' estimated' : usage.pricing === 'mixed' ? ' mixed' : ' reported'}`
              : 'Price unavailable'}
          </strong>
          <small>
            {count.format(usage.requests)} {usage.requests === 1 ? 'operation' : 'operations'}
          </small>
        </span>
      </summary>
      <div className="inspector-provider-detail">
        <p className="inspector-data-note">
          {priced
            ? `${pricingLabels[usage.pricing]} in USD · ${count.format(usage.pricedRequests)} of ${count.format(usage.requests)} operations priced${usage.pricedRequests < usage.requests ? ' · partial subtotal' : ''}. Not an invoice total.`
            : 'No price recorded. Usage can still incur charges.'}
        </p>
        <dl className="inspector-provider-metrics">
          <div>
            <dt>Failures</dt>
            <dd>{count.format(usage.failures)}</dd>
          </div>
          <div>
            <dt>Cancelled</dt>
            <dd>{count.format(usage.cancelled)}</dd>
          </div>
          <div>
            <dt>Total duration</dt>
            <dd>{formatToolDuration(usage.durationMs)}</dd>
          </div>
          {metrics
            .filter(([, value]) => value !== null)
            .map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{count.format(value!)}</dd>
              </div>
            ))}
        </dl>
      </div>
    </details>
  );
}

export function InspectorProviders() {
  const [data, setData] = useState<ProviderUsageResponse | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    setData(null);
    setError('');
    async function refresh() {
      if (document.hidden) {
        timer = setTimeout(() => void refresh(), 5000);
        return;
      }
      try {
        const next = await api<ProviderUsageResponse>('/api/inspector/providers', {
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
  const visibleData = data?.scope === 'owner' ? data : null;
  const total = summarizeProviderUsage(visibleData?.providers ?? []);
  const groups = groupProviderUsage(visibleData?.providers ?? []);
  return (
    <section className="inspector-providers" aria-label="Overall recorded cost">
      {error && <Notice>{error}</Notice>}
      {!visibleData && !error && <Loading label="Loading recorded cost…" />}
      {visibleData && (
        <>
          <div className="inspector-cost-overview">
            <div className="inspector-cost-total">
              <span>Recorded cost</span>
              <strong>{formatModelCost(total.costUsd)}</strong>
            </div>
            <small>
              All activity · Last {visibleData.retentionDays} days
              {total.pricing !== 'unavailable' &&
                ` · ${total.pricing === 'reported' ? 'reported' : total.pricing === 'sdk_estimate' ? 'SDK estimate' : 'reported + estimated'}`}
              {total.partial && total.costUsd !== null && ' · partial'}
              {visibleData.droppedEvents > 0 && ' · incomplete'}
            </small>
            <p className="inspector-data-note">
              {count.format(total.pricedOperations)} of {count.format(total.operations)} operations
              priced. Unknown prices and hosting are excluded. This is not an invoice total.
            </p>
          </div>
          <div className="inspector-provider-groups">
            {groups.map((group) => (
              <section
                className="inspector-provider-group"
                key={group.provider}
                aria-label={group.name}
              >
                <header className="inspector-provider-heading">
                  <span className="inspector-provider-name">
                    <strong>{group.name}</strong>
                    <small>
                      {count.format(group.operations)} operations
                      {group.failures > 0 && ` · ${count.format(group.failures)} failed`}
                    </small>
                  </span>
                  <span className="inspector-provider-total">
                    <strong>{formatModelCost(group.costUsd)}</strong>
                    <small>
                      {group.costUsd !== null
                        ? `${group.pricing === 'reported' ? 'Reported' : group.pricing === 'sdk_estimate' ? 'Estimated' : 'Mixed'}${group.partial ? ' · partial' : ''}`
                        : 'Usage recorded'}
                    </small>
                  </span>
                </header>
                <div className="inspector-provider-breakdown">
                  <p className="inspector-data-note">
                    {count.format(group.pricedOperations)} of {count.format(group.operations)}
                    {' operations priced. Expand an operation for reported metrics.'}
                  </p>
                  {group.rows.map((row) => (
                    <ProviderUsageRow
                      key={JSON.stringify([row.category, row.operation, row.model])}
                      usage={row}
                    />
                  ))}
                </div>
              </section>
            ))}
          </div>
          {!groups.length && (
            <p className="inspector-empty">
              No usage recorded yet. Older activity is not backfilled.
            </p>
          )}
          <p className="inspector-data-note inspector-cost-footnote">
            Operations count recorded adapter activity, not billable requests. Prices stay
            unavailable when no amount was recorded.
          </p>
          {visibleData.droppedEvents > 0 && (
            <Notice>
              {count.format(visibleData.droppedEvents)} usage records could not be saved. Totals are
              incomplete.
            </Notice>
          )}
        </>
      )}
    </section>
  );
}
