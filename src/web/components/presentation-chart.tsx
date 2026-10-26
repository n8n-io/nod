import { useEffect, useId, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import type { Presentation } from '../../shared/presentation';
import { Check, ChevronDown, ChevronLeft, ChevronRight } from './icons';

type ChartVisual = Extract<Presentation, { type: 'chart' }>;
type Series = ChartVisual['series'][number];

const colours = [
  'var(--accent)',
  'var(--info)',
  'var(--success)',
  'var(--warning)',
  'var(--muted-foreground)',
  'color-mix(in srgb, var(--accent) 55%, var(--surface))',
  'color-mix(in srgb, var(--info) 55%, var(--surface))',
  'color-mix(in srgb, var(--success) 55%, var(--surface))',
  'color-mix(in srgb, var(--warning) 55%, var(--surface))',
  'var(--foreground)',
  'color-mix(in srgb, var(--accent) 65%, var(--foreground))',
  'color-mix(in srgb, var(--info) 65%, var(--foreground))',
];

const exact = (value: number) =>
  value !== 0 && (Math.abs(value) < 0.0001 || Math.abs(value) >= 1e15)
    ? String(value)
    : new Intl.NumberFormat(undefined, { maximumSignificantDigits: 21 }).format(value);
const tick = (value: number) =>
  new Intl.NumberFormat(undefined, {
    notation:
      Math.abs(value) >= 1e15 || (value !== 0 && Math.abs(value) < 0.01) ? 'scientific' : 'compact',
    maximumFractionDigits: 1,
  }).format(value);

function nextPoint(event: KeyboardEvent, index: number, count: number) {
  const next = {
    ArrowLeft: Math.max(0, index - 1),
    ArrowRight: Math.min(count - 1, index + 1),
    Home: 0,
    End: count - 1,
  }[event.key];
  if (next !== undefined) event.preventDefault();
  return next;
}

function DataTable({ visual, labels }: { visual: ChartVisual; labels: string[] }) {
  return (
    <details className="chart-data">
      <summary>
        <span>View data table</span>
        <ChevronDown size={16} aria-hidden="true" />
      </summary>
      <div tabIndex={0} role="region" aria-label="Chart data">
        <table>
          <caption>
            {visual.title}
            {visual.unit ? ` (${visual.unit})` : ''}
          </caption>
          <thead>
            <tr>
              <th scope="col">{visual.xLabel || 'Category'}</th>
              {visual.series.map((series) => (
                <th key={series.id} scope="col">
                  {series.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {labels.map((label) => (
              <tr key={label}>
                <th scope="row">{label}</th>
                {visual.series.map((series) => (
                  <td key={series.id}>
                    {series.points.find((point) => point.label === label)?.value ?? '—'}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

function Reading({
  visual,
  series,
  label,
  id,
}: {
  visual: ChartVisual;
  series: Series[];
  label: string;
  id: string;
}) {
  return (
    <div className="chart-reading" id={id} aria-live="polite" aria-atomic="true">
      <span className="chart-reading-label">{label}</span>
      <dl>
        {series.map((item) => {
          const point = item.points.find((point) => point.label === label);
          return (
            <div key={item.id}>
              <dt>
                <i style={{ background: colours[visual.series.indexOf(item)] }} />
                {item.label}
              </dt>
              <dd>
                {point ? exact(point.value) : 'Not supplied'}
                {point && visual.unit && <span>{` ${visual.unit}`}</span>}
              </dd>
            </div>
          );
        })}
      </dl>
    </div>
  );
}

function CartesianChart({ visual }: { visual: ChartVisual }) {
  const canvas = useRef<SVGSVGElement>(null);
  const [width, setWidth] = useState(560);
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const labels = [
    ...new Set(visual.series.flatMap((series) => series.points.map((point) => point.label))),
  ];
  const [selected, setSelected] = useState(visual.chart === 'line' ? labels.length - 1 : 0);
  const readingId = useId();
  const visible = visual.series.filter((series) => !hidden.has(series.id));
  const values = visible.flatMap((series) => series.points.map((point) => point.value));
  const magnitude = Math.max(...values.map(Math.abs)) || 1;
  const low = Math.min(0, ...values.map((value) => value / magnitude));
  const high = Math.max(0, ...values.map((value) => value / magnitude));
  const span = high - low || 1;
  const ratio = (value: number) => (value / magnitude - low) / span;
  const y = (value: number) => 212 - ratio(value) * 178;
  const plotWidth = Math.max(80, width - 88);
  const x = (index: number) =>
    60 + (labels.length === 1 ? 0.5 : index / (labels.length - 1)) * plotWidth;
  const ticks = [low, low + span / 2, low + span];
  const step = Math.max(
    1,
    Math.ceil((labels.length - 1) / Math.max(1, Math.floor(plotWidth / 110))),
  );
  const inspect = (event: PointerEvent<SVGSVGElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    if (!bounds.width) return;
    const position = (((event.clientX - bounds.left) / bounds.width) * width - 60) / plotWidth;
    setSelected(
      Math.max(0, Math.min(labels.length - 1, Math.round(position * (labels.length - 1)))),
    );
  };
  useEffect(() => {
    if (!canvas.current || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry && entry.contentRect.width > 0) setWidth(entry.contentRect.width);
    });
    observer.observe(canvas.current);
    return () => observer.disconnect();
  }, []);
  return (
    <>
      <div className="chart-legend" aria-label="Chart series">
        {visual.series.map((series, index) => (
          <button
            type="button"
            key={series.id}
            aria-pressed={!hidden.has(series.id)}
            disabled={visible.length === 1 && !hidden.has(series.id)}
            onClick={() =>
              setHidden((current) => {
                const next = new Set(current);
                if (next.has(series.id)) next.delete(series.id);
                else next.add(series.id);
                return next;
              })
            }
          >
            <i style={{ color: colours[index] }}>{!hidden.has(series.id) && <Check size={12} />}</i>
            {series.label}
          </button>
        ))}
      </div>
      {(visual.yLabel || visual.unit) && (
        <p className="chart-measure">{[visual.yLabel, visual.unit].filter(Boolean).join(' · ')}</p>
      )}
      <Reading visual={visual} series={visible} label={labels[selected]!} id={readingId} />
      {visual.chart === 'line' ? (
        <>
          <div className="chart-line-controls">
            <span>
              {visual.xLabel || 'Data points'}{' '}
              <span>
                {selected + 1} of {labels.length}
              </span>
            </span>
            <div>
              <button
                type="button"
                aria-label="Previous data point"
                disabled={selected === 0}
                onClick={() => setSelected(selected - 1)}
              >
                <ChevronLeft size={16} />
              </button>
              <button
                type="button"
                aria-label="Next data point"
                disabled={selected === labels.length - 1}
                onClick={() => setSelected(selected + 1)}
              >
                <ChevronRight size={16} />
              </button>
            </div>
          </div>
          <svg
            ref={canvas}
            className="presentation-chart chart-line-plot"
            viewBox={`0 0 ${width} 250`}
            tabIndex={0}
            role="group"
            aria-label={`${visual.title}. Use left and right arrow keys to inspect data points.`}
            aria-describedby={readingId}
            onKeyDown={(event) => {
              const next = nextPoint(event, selected, labels.length);
              if (next !== undefined) setSelected(next);
            }}
            onPointerMove={(event) => {
              if (event.pointerType === 'mouse') inspect(event);
            }}
            onPointerDown={inspect}
          >
            <g aria-hidden="true">
              {ticks.map((value, index) => (
                <g key={index}>
                  <line
                    x1="60"
                    x2={width - 28}
                    y1={212 - ((value - low) / span) * 178}
                    y2={212 - ((value - low) / span) * 178}
                    className="chart-gridline"
                  />
                  <text x="48" y={216 - ((value - low) / span) * 178} textAnchor="end">
                    {tick(value * magnitude)}
                  </text>
                </g>
              ))}
              <line x1="60" x2={width - 28} y1={y(0)} y2={y(0)} className="chart-baseline" />
              <line
                x1={x(selected)}
                x2={x(selected)}
                y1="28"
                y2="218"
                className="chart-crosshair"
              />
              {visible.map((series) => {
                const index = visual.series.indexOf(series);
                return (
                  <g key={series.id} style={{ color: colours[index] }}>
                    <polyline
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeDasharray={index === 1 ? '6 4' : index === 2 ? '2 4' : undefined}
                      points={series.points
                        .map((point) => `${x(labels.indexOf(point.label))},${y(point.value)}`)
                        .join(' ')}
                    />
                    {series.points.map((point) => (
                      <circle
                        key={point.label}
                        cx={x(labels.indexOf(point.label))}
                        cy={y(point.value)}
                        r={point.label === labels[selected] ? 5 : 3}
                        fill="currentColor"
                        stroke="var(--surface)"
                        strokeWidth="2"
                      >
                        <title>{`${series.label}, ${point.label}: ${point.value} ${visual.unit || ''}`}</title>
                      </circle>
                    ))}
                  </g>
                );
              })}
              {labels.map(
                (label, index) =>
                  (index % step === 0 || index === labels.length - 1) && (
                    <text
                      key={label}
                      x={x(index)}
                      y="239"
                      textAnchor={
                        index === 0 ? 'start' : index === labels.length - 1 ? 'end' : 'middle'
                      }
                    >
                      {label.length > 14 ? `${label.slice(0, 12)}…` : label}
                    </text>
                  ),
              )}
            </g>
          </svg>
        </>
      ) : (
        <div className="chart-bars" aria-label={visual.xLabel || 'Chart categories'}>
          {labels.map((label, index) => (
            <button
              type="button"
              key={label}
              className="chart-bar-row"
              aria-pressed={selected === index}
              aria-label={`${label}. ${visible.map((series) => `${series.label}: ${series.points.find((point) => point.label === label)?.value ?? 'not supplied'} ${visual.unit || ''}`).join('. ')}`}
              onFocus={() => setSelected(index)}
              onClick={() => setSelected(index)}
            >
              <span className="chart-bar-heading">
                <span>{label}</span>
                {visible.length === 1 && (
                  <strong>
                    {visible[0]!.points.some((point) => point.label === label)
                      ? exact(visible[0]!.points.find((point) => point.label === label)!.value)
                      : '—'}
                  </strong>
                )}
              </span>
              <svg
                className="presentation-chart chart-bars-plot"
                viewBox={`0 0 100 ${visible.length * 13 + 5}`}
                preserveAspectRatio="none"
                aria-hidden="true"
              >
                <line
                  x1={ratio(0) * 100}
                  x2={ratio(0) * 100}
                  y1="0"
                  y2={visible.length * 13 + 5}
                  className="chart-baseline"
                  vectorEffect="non-scaling-stroke"
                />
                {visible.map((series, seriesIndex) => {
                  const point = series.points.find((point) => point.label === label);
                  return point ? (
                    <g key={series.id} style={{ color: colours[visual.series.indexOf(series)] }}>
                      <rect
                        x={Math.min(ratio(0), ratio(point.value)) * 100}
                        y={seriesIndex * 13 + 3}
                        width={Math.abs(ratio(point.value) - ratio(0)) * 100}
                        height="8"
                        rx="1"
                        fill="currentColor"
                      />
                      {point.value === 0 && (
                        <line
                          x1={ratio(0) * 100}
                          x2={ratio(0) * 100}
                          y1={seriesIndex * 13 + 2}
                          y2={seriesIndex * 13 + 12}
                          stroke="currentColor"
                          strokeWidth="3"
                          vectorEffect="non-scaling-stroke"
                        />
                      )}
                    </g>
                  ) : null;
                })}
              </svg>
            </button>
          ))}
          <div className="chart-scale" aria-hidden="true">
            <span>{tick(low * magnitude)}</span>
            <span>{tick((low + span) * magnitude)}</span>
          </div>
        </div>
      )}
      <DataTable visual={visual} labels={labels} />
    </>
  );
}

function slicePath(start: number, end: number, inner: number) {
  const point = (radius: number, angle: number) =>
    `${120 + Math.cos(angle) * radius} ${120 + Math.sin(angle) * radius}`;
  if (end - start >= Math.PI * 2 - 1e-10)
    return `M 120 24 A 96 96 0 1 1 120 216 A 96 96 0 1 1 120 24 Z${inner ? ` M 120 ${120 - inner} A ${inner} ${inner} 0 1 0 120 ${120 + inner} A ${inner} ${inner} 0 1 0 120 ${120 - inner} Z` : ''}`;
  const large = end - start > Math.PI ? 1 : 0;
  return `M ${point(96, start)} A 96 96 0 ${large} 1 ${point(96, end)} ${inner ? `L ${point(inner, end)} A ${inner} ${inner} 0 ${large} 0 ${point(inner, start)}` : 'L 120 120'} Z`;
}

function RadialChart({ visual }: { visual: ChartVisual }) {
  const points = visual.series[0]!.points;
  const [selected, setSelected] = useState(points.findIndex((point) => point.value > 0));
  const scale = Math.max(...points.map((point) => point.value));
  const sum = points.reduce((total, point) => total + point.value / scale, 0);
  const total = points.reduce((total, point) => total + point.value, 0);
  const share = (value: number) => value / scale / sum;
  const percent = (value: number) =>
    value > 0 && share(value) < 0.001
      ? '<0.1%'
      : new Intl.NumberFormat(undefined, { style: 'percent', maximumFractionDigits: 1 }).format(
          share(value),
        );
  let angle = -Math.PI / 2;
  return (
    <>
      <div className="chart-radial-summary">
        <span>{visual.series[0]!.label}</span>
        {Number.isFinite(total) && (
          <strong>
            {exact(Number(total.toPrecision(15)))} <span>{visual.unit || 'total'}</span>
          </strong>
        )}
      </div>
      <div className="chart-radial-layout">
        <div className="chart-radial-figure">
          <svg
            className="presentation-chart chart-radial-plot"
            viewBox="0 0 240 240"
            role="img"
            aria-label={`${visual.title}. Select a category below to inspect its share.`}
          >
            {points.map((point, index) => {
              const start = angle;
              angle += share(point.value) * Math.PI * 2;
              return (
                point.value > 0 && (
                  <path
                    key={point.label}
                    d={slicePath(start, angle, visual.chart === 'donut' ? 64 : 0)}
                    fill={colours[index]}
                    fillRule="evenodd"
                    stroke="var(--surface)"
                    strokeWidth="2"
                    className={selected === index ? 'is-selected' : ''}
                    onPointerEnter={(event) => {
                      if (event.pointerType === 'mouse') setSelected(index);
                    }}
                    onClick={() => setSelected(index)}
                  >
                    <title>{`${point.label}: ${point.value} ${visual.unit || ''}, ${percent(point.value)}`}</title>
                  </path>
                )
              );
            })}
          </svg>
          {visual.chart === 'donut' && (
            <div className="chart-donut-centre" aria-hidden="true">
              <strong>{percent(points[selected]!.value)}</strong>
              <span>of total</span>
            </div>
          )}
        </div>
        <div className="chart-slices" aria-label="Chart categories">
          {points.map((point, index) => (
            <button
              type="button"
              key={point.label}
              className="chart-slice-option"
              aria-pressed={selected === index}
              onFocus={() => setSelected(index)}
              onClick={() => setSelected(index)}
            >
              <i style={{ background: colours[index] }} />
              <span>
                <span>{point.label}</span>
                <strong>
                  {exact(point.value)}
                  {visual.unit && <small>{` ${visual.unit}`}</small>}
                </strong>
              </span>
              <span className="chart-share">{percent(point.value)}</span>
            </button>
          ))}
        </div>
      </div>
      <DataTable visual={visual} labels={points.map((point) => point.label)} />
    </>
  );
}

export function PresentationChart({ visual }: { visual: ChartVisual }) {
  return (
    <div className={`chart-content chart-${visual.chart}`}>
      {visual.chart === 'pie' || visual.chart === 'donut' ? (
        <RadialChart visual={visual} />
      ) : (
        <CartesianChart visual={visual} />
      )}
    </div>
  );
}
