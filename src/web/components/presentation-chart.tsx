import { useEffect, useId, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import type { Presentation } from '../../shared/presentation';

type ChartVisual = Extract<Presentation, { type: 'chart' }>;
type Series = ChartVisual['series'][number];

const colours = Array.from({ length: 12 }, (_, index) => `var(--chart-${index + 1})`);
const outlines = Array.from({ length: 3 }, (_, index) => `var(--chart-line-${index + 1})`);

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
    ArrowUp: Math.max(0, index - 1),
    ArrowDown: Math.min(count - 1, index + 1),
    Home: 0,
    End: count - 1,
  }[event.key];
  if (next !== undefined) event.preventDefault();
  return next;
}

function Reading({
  visual,
  series,
  label,
  id,
  left,
  top,
}: {
  visual: ChartVisual;
  series: Series[];
  label: string;
  id: string;
  left?: boolean;
  top?: number;
}) {
  return (
    <div
      className={`chart-reading${left ? ' is-left' : ''}`}
      id={id}
      ref={(node) => {
        if (node && top !== undefined)
          node.style.top = `${Math.max(8, Math.min(top, (node.parentElement?.clientHeight ?? 0) - node.offsetHeight - 8))}px`;
      }}
      role="status"
      aria-atomic="true"
    >
      <span className="chart-reading-label">{label}</span>
      {visual.unit && <span className="chart-reading-unit">Values in {visual.unit}</span>}
      <dl>
        {series.map((item) => {
          const point = item.points.find((point) => point.label === label);
          return (
            <div key={item.id}>
              <dt>
                <i style={{ background: colours[visual.series.indexOf(item)] }} />
                {item.label}
              </dt>
              <dd>{point ? exact(point.value) : 'Not supplied'}</dd>
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
  const [selection, setSelected] = useState(visual.chart === 'line' ? labels.length - 1 : 0);
  const selected = Math.min(selection, labels.length - 1);
  const [active, setActive] = useState(false);
  const [readingTop, setReadingTop] = useState(8);
  const readingId = useId();
  const visible = visual.series.filter((series) => !hidden.has(series.id));
  const values = visible.flatMap((series) => series.points.map((point) => point.value));
  const magnitude = Math.max(...values.map(Math.abs)) || 1;
  const low = Math.min(0, ...values.map((value) => value / magnitude));
  const high = Math.max(0, ...values.map((value) => value / magnitude));
  const span = high - low || 1;
  const ratio = (value: number) => (value / magnitude - low) / span;
  const y = (value: number) => 190 - ratio(value) * 166;
  const plotWidth = Math.max(80, width - 76);
  const x = (index: number) =>
    54 + (labels.length === 1 ? 0.5 : index / (labels.length - 1)) * plotWidth;
  const ticks = [low, low + span / 2, low + span];
  const step = Math.max(
    1,
    Math.ceil((labels.length - 1) / Math.max(1, Math.floor(plotWidth / 110))),
  );
  const inspect = (event: PointerEvent<SVGSVGElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    if (!bounds.width) return;
    const position = (((event.clientX - bounds.left) / bounds.width) * width - 54) / plotWidth;
    setSelected(
      Math.max(0, Math.min(labels.length - 1, Math.round(position * (labels.length - 1)))),
    );
    setActive(true);
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
      <div className="chart-header">
        <div className="chart-legend" aria-label="Chart series">
          {visual.series.map((series, index) =>
            visual.series.length > 1 ? (
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
                <i style={{ background: colours[index] }} />
                {series.label}
              </button>
            ) : (
              <span className="chart-series" key={series.id}>
                <i style={{ background: colours[index] }} />
                {series.label}
              </span>
            ),
          )}
        </div>
        {(visual.yLabel || visual.unit) && (
          <span className="chart-measure">
            {visual.yLabel}
            {visual.unit && (visual.yLabel ? ` (${visual.unit})` : visual.unit)}
          </span>
        )}
      </div>
      <div
        className="chart-plot"
        onPointerLeave={(event) => {
          if (event.pointerType === 'mouse') setActive(false);
        }}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) setActive(false);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && active) {
            event.stopPropagation();
            setActive(false);
          }
        }}
      >
        {active && (visual.chart === 'line' || visible.length > 1) && (
          <Reading
            visual={visual}
            series={visible}
            label={labels[selected]!}
            id={readingId}
            left={visual.chart === 'line' && selected >= labels.length / 2}
            top={visual.chart === 'bar' ? readingTop : undefined}
          />
        )}
        {visual.chart === 'line' ? (
          <>
            <svg
              ref={canvas}
              className="presentation-chart chart-line-plot"
              viewBox={`0 0 ${width} 224`}
              tabIndex={0}
              role="group"
              aria-label={`${visual.title}. ${[visual.xLabel, visual.yLabel].filter(Boolean).join('. ')}. Use arrow keys to inspect data points.`}
              aria-describedby={active ? readingId : undefined}
              onFocus={() => setActive(true)}
              onKeyDown={(event) => {
                const next = nextPoint(event, selected, labels.length);
                if (next !== undefined) {
                  setSelected(next);
                  setActive(true);
                }
              }}
              onPointerMove={(event) => {
                if (event.pointerType === 'mouse') inspect(event);
              }}
              onPointerDown={(event) => {
                event.currentTarget.focus();
                inspect(event);
              }}
              onPointerCancel={() => setActive(false)}
            >
              <g aria-hidden="true">
                {ticks.map((value, index) => (
                  <g key={index}>
                    <line
                      x1="54"
                      x2={width - 22}
                      y1={190 - ((value - low) / span) * 166}
                      y2={190 - ((value - low) / span) * 166}
                      className="chart-gridline"
                    />
                    <text x="43" y={194 - ((value - low) / span) * 166} textAnchor="end">
                      {tick(value * magnitude)}
                    </text>
                  </g>
                ))}
                <line x1="54" x2={width - 22} y1={y(0)} y2={y(0)} className="chart-baseline" />
                {active && (
                  <line
                    x1={x(selected)}
                    x2={x(selected)}
                    y1="20"
                    y2="194"
                    className="chart-crosshair"
                  />
                )}
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
                          r={active && point.label === labels[selected] ? 5 : 3}
                          fill="currentColor"
                          stroke="var(--surface)"
                          strokeWidth="2"
                        ></circle>
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
                        y="215"
                        textAnchor={
                          labels.length === 1
                            ? 'middle'
                            : index === 0
                              ? 'start'
                              : index === labels.length - 1
                                ? 'end'
                                : 'middle'
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
                tabIndex={selected === index ? 0 : -1}
                aria-pressed={active && selected === index}
                aria-label={`${label}. ${visible.map((series) => `${series.label}: ${series.points.find((point) => point.label === label)?.value ?? 'not supplied'} ${visual.unit || ''}`).join('. ')}`}
                onFocus={(event) => {
                  setSelected(index);
                  setReadingTop(event.currentTarget.offsetTop);
                  setActive(true);
                }}
                onPointerEnter={(event) => {
                  if (event.pointerType === 'mouse') {
                    setSelected(index);
                    setReadingTop(event.currentTarget.offsetTop);
                    setActive(true);
                  }
                }}
                onClick={(event) => {
                  setSelected(index);
                  setReadingTop(event.currentTarget.offsetTop);
                  setActive(true);
                }}
                onKeyDown={(event) => {
                  const next = nextPoint(event, index, labels.length);
                  if (next !== undefined)
                    event.currentTarget.parentElement?.querySelectorAll('button')[next]?.focus();
                }}
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
                  viewBox={`0 0 100 ${visible.length * 10 + 4}`}
                  style={{ height: visible.length * 10 + 4 }}
                  preserveAspectRatio="none"
                  aria-hidden="true"
                >
                  <line
                    x1={ratio(0) * 100}
                    x2={ratio(0) * 100}
                    y1="0"
                    y2={visible.length * 10 + 4}
                    className="chart-baseline"
                    vectorEffect="non-scaling-stroke"
                  />
                  {visible.map((series, seriesIndex) => {
                    const point = series.points.find((point) => point.label === label);
                    return point ? (
                      <g key={series.id} style={{ color: colours[visual.series.indexOf(series)] }}>
                        <rect
                          x={Math.min(ratio(0), ratio(point.value)) * 100}
                          y={seriesIndex * 10 + 2}
                          width={Math.abs(ratio(point.value) - ratio(0)) * 100}
                          height="7"
                          rx="1"
                          fill="currentColor"
                          stroke={outlines[visual.series.indexOf(series)]}
                          strokeWidth="1"
                          vectorEffect="non-scaling-stroke"
                        />
                        {point.value === 0 && (
                          <line
                            x1={ratio(0) * 100}
                            x2={ratio(0) * 100}
                            y1={seriesIndex * 10 + 1}
                            y2={seriesIndex * 10 + 10}
                            stroke={outlines[visual.series.indexOf(series)]}
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
      </div>
      {visual.xLabel && <p className="chart-axis-label">{visual.xLabel}</p>}
      <div className="sr-only">
        <table>
          <caption>{visual.title}</caption>
          <thead>
            <tr>
              <th scope="col">{visual.xLabel || 'Category'}</th>
              {visual.series.map((series) => (
                <th scope="col" key={series.id}>
                  {series.label}
                  {visual.unit ? ` (${visual.unit})` : ''}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {labels.map((label) => (
              <tr key={label}>
                <th scope="row">{label}</th>
                {visual.series.map((series) => {
                  const point = series.points.find((point) => point.label === label);
                  return <td key={series.id}>{point ? exact(point.value) : 'Not supplied'}</td>;
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
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
  const percentages = visual.unit?.trim() === '%';
  const [selected, setSelected] = useState<number | null>(null);
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
  const current = selected === null ? undefined : points[selected];
  let angle = -Math.PI / 2;
  return (
    <>
      <div className="chart-header">
        <span className="chart-series">{visual.series[0]!.label}</span>
      </div>
      <div
        className="chart-radial-layout"
        onPointerLeave={(event) => {
          if (event.pointerType === 'mouse') setSelected(null);
        }}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) setSelected(null);
        }}
      >
        <div className="chart-radial-figure">
          <svg
            className={`presentation-chart chart-radial-plot${current ? ' has-selection' : ''}`}
            viewBox="12 12 216 216"
            role="img"
            aria-label={`${visual.title}. Total: ${exact(Number(total.toPrecision(15)))} ${visual.unit || ''}. Select a category in the legend to inspect it.`}
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
                    <title>{`${point.label}: ${point.value} ${visual.unit || ''}${percentages ? '' : `, ${percent(point.value)}`}`}</title>
                  </path>
                )
              );
            })}
          </svg>
          {visual.chart === 'donut' && (
            <div className="chart-donut-centre" aria-hidden="true">
              <strong>
                {tick(current?.value ?? total)}
                {percentages ? '%' : ''}
              </strong>
              <span>{current?.label ?? 'Total'}</span>
            </div>
          )}
        </div>
        <div className="chart-slices" aria-label="Chart categories">
          {points.map((point, index) => (
            <button
              type="button"
              key={point.label}
              className="chart-slice-option"
              tabIndex={index === (selected ?? 0) ? 0 : -1}
              aria-label={`${point.label}: ${exact(point.value)} ${visual.unit || ''}${percentages ? '' : `, ${percent(point.value)}`}`}
              aria-pressed={selected === index}
              onFocus={() => setSelected(index)}
              onPointerEnter={(event) => {
                if (event.pointerType === 'mouse') setSelected(index);
              }}
              onClick={() => setSelected(index)}
              onKeyDown={(event) => {
                const next = nextPoint(event, index, points.length);
                if (next !== undefined)
                  event.currentTarget.parentElement?.querySelectorAll('button')[next]?.focus();
                if (event.key === 'Escape' && selected !== null) {
                  event.stopPropagation();
                  setSelected(null);
                }
              }}
            >
              <i style={{ background: colours[index] }} />
              <span className="chart-slice-label">{point.label}</span>
              <span className="chart-slice-value">
                <strong>
                  {exact(point.value)}
                  {visual.unit ? `${percentages ? '' : ' '}${visual.unit}` : ''}
                </strong>
                {!percentages && <small>{percent(point.value)}</small>}
              </span>
            </button>
          ))}
        </div>
      </div>
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
