import { useId, useState } from 'react';
import { mapLocationUrl, presentationSchema, type Presentation } from '../../shared/presentation';
import { ArrowRight, ExternalLink, MapPin } from './icons';
import { useArtifactDrawer } from './artifact-context';
import { ConnectApps } from './presentation-apps';
import { Booking } from './presentation-booking';
import { PresentationChart } from './presentation-chart';
import { Flights, Seats } from './presentation-travel';

type Visual<T extends Presentation['type']> = Extract<Presentation, { type: T }>;

function SourceLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">
      {children}
      <ExternalLink size={12} aria-hidden="true" />
    </a>
  );
}

export function MessagePresentation({ value }: { value: unknown }) {
  const parsed = presentationSchema.safeParse(value);
  const titleId = useId();
  if (!parsed.success)
    return (
      <p className="presentation-unavailable" role="status">
        This visual is unavailable. The answer is still available above.
      </p>
    );
  const visual = parsed.data;
  if (visual.type === 'apps') return <ConnectApps visual={visual} />;
  return (
    <section
      className={`message-presentation presentation-${visual.type}`}
      aria-labelledby={titleId}
    >
      <header className="presentation-heading">
        <h3 id={titleId}>{visual.title}</h3>
        {visual.caption && <p>{visual.caption}</p>}
        {visual.asOf && <p className="presentation-footnote">As of {visual.asOf}</p>}
      </header>
      {visual.type === 'image' && <PresentedImage key={visual.artifactId} visual={visual} />}
      {visual.type === 'flights' && <Flights key={JSON.stringify(visual)} visual={visual} />}
      {visual.type === 'seats' && <Seats key={JSON.stringify(visual)} visual={visual} />}
      {visual.type === 'map' && <Places key={JSON.stringify(visual)} visual={visual} />}
      {visual.type === 'booking' && <Booking visual={visual} />}
      {visual.type === 'diagram' && <Diagram key={JSON.stringify(visual)} visual={visual} />}
      {visual.type === 'chart' && (
        <PresentationChart key={JSON.stringify(visual)} visual={visual} />
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
      onClick={(event) =>
        drawer.open(visual.artifactId, {
          element: event.currentTarget,
          keyboard: event.detail === 0,
        })
      }
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

function Places({ visual }: { visual: Visual<'map'> }) {
  const [selected, setSelected] = useState(visual.places[0]!.id);
  const [map, setMap] = useState(false);
  const place = visual.places.find((item) => item.id === selected)!;
  const latitudes = visual.places.map((item) => item.latitude);
  const normalized = visual.places.map((item) => (item.longitude + 360) % 360);
  const ordered = [...normalized].sort((a, b) => a - b);
  let start = ordered[0]!;
  let largestGap = 0;
  ordered.forEach((longitude, index) => {
    const next = ordered[(index + 1) % ordered.length]! + (index === ordered.length - 1 ? 360 : 0);
    if (next - longitude > largestGap) {
      largestGap = next - longitude;
      start = ordered[(index + 1) % ordered.length]!;
    }
  });
  const longitudes = normalized.map((longitude) =>
    longitude < start ? longitude + 360 : longitude,
  );
  const west = Math.min(...longitudes),
    east = Math.max(...longitudes);
  const south = Math.min(...latitudes),
    north = Math.max(...latitudes);
  const span = Math.max(east - west, north - south, 0.002);
  const centerLat = Math.max(-85, Math.min(85, place.latitude));
  const query = new URLSearchParams({
    bbox: [
      Math.max(-180, place.longitude - 0.014),
      Math.max(-85, centerLat - 0.008),
      Math.min(180, place.longitude + 0.014),
      Math.min(85, centerLat + 0.008),
    ].join(','),
    layer: 'mapnik',
    marker: `${place.latitude},${place.longitude}`,
  });
  return (
    <>
      <div className="places-map">
        {map ? (
          <iframe
            key={selected}
            title={`Map of ${place.name}`}
            src={`https://www.openstreetmap.org/export/embed.html?${query}`}
            sandbox="allow-scripts allow-same-origin"
            referrerPolicy="no-referrer"
            loading="lazy"
          />
        ) : (
          <>
            <span className="places-map-label">Relative locations</span>
            <div className="places-plot" aria-label="Relative location overview">
              {visual.places.map((item, index) => (
                <button
                  key={item.id}
                  type="button"
                  className="place-pin"
                  style={{
                    left: `${50 + ((longitudes[index]! - (west + east) / 2) / span) * 68}%`,
                    top: `${50 - ((item.latitude - (south + north) / 2) / span) * 62}%`,
                  }}
                  aria-label={`Show ${item.name}`}
                  aria-pressed={item.id === selected}
                  onClick={() => setSelected(item.id)}
                >
                  {index + 1}
                </button>
              ))}
            </div>
            <button type="button" className="load-map" onClick={() => setMap(true)}>
              <MapPin size={15} aria-hidden="true" />
              Load map <span>OpenStreetMap</span>
            </button>
          </>
        )}
      </div>
      <ol className="places-list">
        {visual.places.map((item, index) => (
          <li key={item.id} className={item.id === selected ? 'is-selected' : ''}>
            <button
              type="button"
              className="place-select"
              aria-pressed={item.id === selected}
              onClick={() => setSelected(item.id)}
            >
              <span className="place-index">{index + 1}</span>
              <span>
                <strong>{item.name}</strong>
                {item.description && <span>{item.description}</span>}
              </span>
            </button>
            <div className="place-links">
              <SourceLink href={mapLocationUrl(item)}>
                <span>
                  View map<span className="sr-only"> for {item.name}</span>
                </span>
              </SourceLink>
              {item.url && (
                <SourceLink href={item.url}>
                  <span>
                    Source<span className="sr-only"> for {item.name}</span>
                  </span>
                </SourceLink>
              )}
            </div>
          </li>
        ))}
      </ol>
      <div className="place-detail" aria-live="polite">
        <span>{place.name}</span>
        <span>
          {place.latitude.toFixed(5)}, {place.longitude.toFixed(5)}
        </span>
      </div>
    </>
  );
}

function Diagram({ visual }: { visual: Visual<'diagram'> }) {
  const [selected, setSelected] = useState(visual.nodes[0]!.id);
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
  const node = nodes.get(selected)!;
  const connections = visual.edges.filter((edge) => edge.from === selected || edge.to === selected);
  return (
    <>
      <div className="diagram-scroll" tabIndex={0} role="region" aria-label="Diagram">
        <div className="diagram-canvas" style={{ width, height: levels.length * 116 }}>
          <svg width={width} height={levels.length * 116} aria-hidden="true">
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
    </>
  );
}
