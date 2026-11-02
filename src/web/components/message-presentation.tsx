import { useEffect, useId, useRef, useState } from 'react';
import { presentationSchema, type Presentation } from '../../shared/presentation';
import { ArrowRight, ChevronDown, ExternalLink, Maximize2 } from './icons';
import { useArtifactDrawer } from './artifact-context';
import { ConnectApps } from './presentation-apps';
import { Booking } from './presentation-booking';
import { PresentationChart } from './presentation-chart';
import { Flights, Seats } from './presentation-travel';
import { useAnalyticsView } from '../hooks/use-analytics-view';
import { captureAnalytics } from '../lib/analytics';
import { Places } from './presentation-places';
import { Button } from './ui';

type Visual<T extends Presentation['type']> = Extract<Presentation, { type: T }>;

export function MessagePresentation({
  value,
  messageId,
  analyticsKey,
}: {
  value: unknown;
  messageId?: string;
  analyticsKey?: string;
}) {
  const parsed = presentationSchema.safeParse(value);
  const drawer = useArtifactDrawer();
  const titleId = useId();
  const root = useAnalyticsView<HTMLElement, 'presentation_viewed'>(
    'presentation_viewed',
    { kind: parsed.success ? parsed.data.type : 'image' },
    analyticsKey ?? messageId ?? titleId,
    parsed.success,
  );
  if (!parsed.success)
    return (
      <p className="presentation-unavailable" role="status">
        This visual is unavailable. The answer is still available above.
      </p>
    );
  const visual = parsed.data;
  if (visual.type === 'apps') return <ConnectApps visual={visual} analyticsRef={root} />;
  const expandAction =
    messageId && visual.type !== 'image' ? (
      <Button
        variant="ghost"
        size="icon"
        className="presentation-expand"
        aria-label={`Open ${visual.title}`}
        title="Open visual"
        onClick={(event) => {
          drawer.open(`presentation:${messageId}`, {
            element: event.currentTarget,
            keyboard: event.detail === 0,
          });
          captureAnalytics('presentation_action', {
            kind: visual.type,
            location: 'message',
            action: 'open',
          });
        }}
      >
        <Maximize2 size={16} aria-hidden="true" />
      </Button>
    ) : null;
  return (
    <section
      ref={root}
      data-analytics-private
      className={`message-presentation presentation-${visual.type}`}
      aria-label={visual.title}
    >
      {visual.type !== 'flights' && visual.type !== 'booking' && expandAction}
      {visual.type === 'image' && <PresentedImage key={visual.artifactId} visual={visual} />}
      {visual.type === 'flights' && (
        <Flights key={JSON.stringify(visual)} visual={visual} action={expandAction} />
      )}
      {visual.type === 'seats' && <Seats key={JSON.stringify(visual)} visual={visual} />}
      {visual.type === 'map' && <Places key={JSON.stringify(visual)} visual={visual} />}
      {visual.type === 'booking' && <Booking visual={visual} action={expandAction} />}
      {visual.type === 'diagram' && <Diagram key={JSON.stringify(visual)} visual={visual} />}
      {visual.type === 'chart' && (
        <PresentationChart key={JSON.stringify(visual)} visual={visual} />
      )}
      {visual.type !== 'flights' && (visual.asOf || visual.sources.length > 0) && (
        <details className="presentation-sources">
          <summary>
            {visual.sources.length ? 'Sources' : 'Data details'}
            <ChevronDown size={14} aria-hidden="true" />
          </summary>
          <div>
            {visual.asOf && <p>As of {visual.asOf}</p>}
            {visual.sources.length > 0 && (
              <ul>
                {visual.sources.map((source, index) => (
                  <li key={index}>
                    <a
                      href={source.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      referrerPolicy="no-referrer"
                    >
                      {source.label}
                      <ExternalLink size={12} aria-hidden="true" />
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </details>
      )}
    </section>
  );
}

function PresentedImage({ visual }: { visual: Visual<'image'> }) {
  const drawer = useArtifactDrawer();
  const [failed, setFailed] = useState(false);
  return failed ? (
    <p className="presentation-empty">
      {visual.alt}
      <br />
      The image could not be loaded.
    </p>
  ) : (
    <button
      type="button"
      className="presentation-image-button"
      aria-label={`Open image: ${visual.alt}`}
      onClick={(event) => {
        drawer.open(visual.artifactId, {
          element: event.currentTarget,
          keyboard: event.detail === 0,
        });
        captureAnalytics('presentation_action', {
          kind: visual.type,
          location: 'message',
          action: 'open',
        });
      }}
    >
      <img
        src={`/api/artifacts/${visual.artifactId}`}
        alt={visual.alt}
        loading="lazy"
        onError={() => setFailed(true)}
      />
    </button>
  );
}

function Diagram({ visual }: { visual: Visual<'diagram'> }) {
  const viewport = useRef<HTMLDivElement>(null);
  const [availableWidth, setAvailableWidth] = useState(0);
  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const measure = () => setAvailableWidth(element.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const [selected, setSelected] = useState<string | null>(null);
  const markerId = useId().replaceAll(':', '');
  const nodes = new Map(visual.nodes.map((node, index) => [node.id, { ...node, index }]));
  const active = new Set<string>();
  const visited = new Set<string>();
  const returns = new Set<(typeof visual.edges)[number]>();
  const visit = (id: string) => {
    if (visited.has(id)) return;
    active.add(id);
    for (const edge of visual.edges.filter((edge) => edge.from === id)) {
      if (active.has(edge.to)) returns.add(edge);
      else visit(edge.to);
    }
    active.delete(id);
    visited.add(id);
  };
  for (const id of nodes.keys())
    if (!visual.edges.some((edge) => edge.to === id && edge.from !== id)) visit(id);
  for (const id of nodes.keys()) visit(id);
  const rows = new Map<string, number>();
  const pending = new Set(nodes.keys());
  for (let pass = 0; pass < nodes.size; pass++) {
    for (const id of pending) {
      const parents = visual.edges.filter((edge) => edge.to === id && !returns.has(edge));
      if (parents.some((edge) => !rows.has(edge.from))) continue;
      rows.set(id, Math.max(-1, ...parents.map((edge) => rows.get(edge.from)!)) + 1);
      pending.delete(id);
    }
  }
  for (const id of pending) rows.set(id, Math.max(-1, ...rows.values()) + 1);
  const levels = Array.from(new Set(rows.values())).sort((a, b) => a - b);
  const width = Math.max(
    260,
    ...levels.map((level) => [...rows.values()].filter((row) => row === level).length * 180 + 80),
  );
  const points = new Map<string, { x: number; y: number }>();
  for (const level of levels) {
    const ids = [...rows].filter(([, row]) => row === level).map(([id]) => id);
    ids.forEach((id, index) =>
      points.set(id, { x: 40 + ((index + 0.5) * (width - 80)) / ids.length, y: level * 116 + 56 }),
    );
  }
  const scale = availableWidth ? Math.min(1, availableWidth / width) : 1;
  const height = levels.length * 116;
  const node = selected ? nodes.get(selected) : undefined;
  const connections = visual.edges.filter((edge) => edge.from === selected || edge.to === selected);
  return (
    <>
      <div className="diagram-scroll" ref={viewport} role="group" aria-label="Diagram">
        <div className="diagram-fit" style={{ width: width * scale, height: height * scale }}>
          <div className="diagram-canvas" style={{ width, height, transform: `scale(${scale})` }}>
            <svg width={width} height={height} aria-hidden="true">
              <defs>
                <marker
                  id={markerId}
                  viewBox="0 0 10 10"
                  refX="9"
                  refY="5"
                  markerWidth="6"
                  markerHeight="6"
                  orient="auto-start-reverse"
                >
                  <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
                </marker>
              </defs>
              {visual.edges.map((edge, index) => {
                const a = points.get(edge.from)!,
                  b = points.get(edge.to)!;
                const y1 = a.y + 34,
                  y2 = b.y - 36;
                const rail = width - 12 - (index % 6) * 5;
                const path =
                  edge.from === edge.to
                    ? `M ${a.x + 78} ${a.y - 14} H ${a.x + 98} V ${a.y + 50} H ${a.x} V ${a.y + 36}`
                    : b.y - a.y === 116
                      ? `M ${a.x} ${y1} C ${a.x} ${(y1 + y2) / 2}, ${b.x} ${(y1 + y2) / 2}, ${b.x} ${y2}`
                      : `M ${a.x} ${y1} V ${y1 + 16} H ${rail} V ${y2 - 16} H ${b.x} V ${y2}`;
                return (
                  <path
                    key={index}
                    d={path}
                    markerEnd={`url(#${markerId})`}
                    className={edge.from === selected || edge.to === selected ? 'is-selected' : ''}
                  />
                );
              })}
            </svg>
            {visual.nodes.map((item) => {
              const point = points.get(item.id)!;
              return (
                <button
                  key={item.id}
                  type="button"
                  className="diagram-node"
                  style={{ left: point.x - 78, top: point.y - 34 }}
                  aria-pressed={item.id === selected}
                  title={item.label}
                  onClick={() => setSelected(item.id)}
                >
                  <span>{item.label}</span>
                </button>
              );
            })}
          </div>
        </div>
      </div>
      {node && (
        <div className="diagram-detail" aria-live="polite">
          <strong>{node.label}</strong>
          {node.detail && <p>{node.detail}</p>}
          {connections.length > 0 && (
            <ul>
              {connections.map((edge, index) => (
                <li key={index}>
                  {nodes.get(edge.from)!.label}
                  <ArrowRight size={13} aria-label="to" />
                  {nodes.get(edge.to)!.label}
                  {edge.label && <span>{edge.label}</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </>
  );
}
