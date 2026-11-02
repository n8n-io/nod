import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { mapLocationUrl, type Presentation } from '../../shared/presentation';
import { ExternalLink, MapPin } from './icons';
import { Button } from './ui';
import { Tooltip } from './tooltip';

type PlacesVisual = Extract<Presentation, { type: 'map' }>;

export function Places({ visual }: { visual: PlacesVisual }) {
  const [selected, setSelected] = useState(visual.places[0]!.id);
  const [map, setMap] = useState(false);
  const plot = useRef<HTMLDivElement>(null);
  const [plotSize, setPlotSize] = useState({ width: 256, height: 136 });

  useEffect(() => {
    if (!plot.current) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry && entry.contentRect.width && entry.contentRect.height) {
        setPlotSize({ width: entry.contentRect.width, height: entry.contentRect.height });
      }
    });
    observer.observe(plot.current);
    return () => observer.disconnect();
  }, [map]);

  const place = visual.places.find((item) => item.id === selected)!;
  const latitudes = visual.places.map(
    (item) =>
      (Math.log(
        Math.tan(Math.PI / 4 + (Math.max(-85, Math.min(85, item.latitude)) * Math.PI) / 360),
      ) *
        180) /
      Math.PI,
  );
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
  const west = Math.min(...longitudes);
  const east = Math.max(...longitudes);
  const south = Math.min(...latitudes);
  const north = Math.max(...latitudes);
  const span = Math.max(east - west, north - south, 0.002);
  const points = visual.places.map((item, index) => ({
    item,
    index,
    x: 50 + ((longitudes[index]! - (west + east) / 2) / span) * 64,
    y: 50 - ((latitudes[index]! - (south + north) / 2) / span) * 62,
  }));
  function position(group: typeof points) {
    const columns = Math.min(4, group.length);
    const rows = Math.ceil(group.length / columns);
    const width = group.length === 1 ? 36 : columns * 32 + (columns - 1) * 4 + 10;
    const height = group.length === 1 ? 36 : rows * 32 + (rows - 1) * 4 + 10;
    const x =
      (group.reduce((sum, point) => sum + point.x, 0) / group.length / 100) * plotSize.width;
    const y =
      (group.reduce((sum, point) => sum + point.y, 0) / group.length / 100) * plotSize.height;
    return {
      columns,
      width,
      height,
      x: Math.max(width / 2, Math.min(plotSize.width - width / 2, x)),
      y: Math.max(height / 2, Math.min(plotSize.height - height / 2, y)),
    };
  }
  const groups = points.map((point) => [point]);
  for (let index = 0; index < groups.length; index += 1) {
    for (let other = index + 1; other < groups.length; other += 1) {
      const first = position(groups[index]!);
      const next = position(groups[other]!);
      if (
        Math.abs(first.x - next.x) < (first.width + next.width) / 2 + 8 &&
        Math.abs(first.y - next.y) < (first.height + next.height) / 2 + 8
      ) {
        groups[index]!.push(...groups[other]!);
        groups[index]!.sort((a, b) => a.index - b.index);
        groups.splice(other, 1);
        index = -1;
        break;
      }
    }
  }
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

  function move(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? visual.places.length - 1
          : ['ArrowRight', 'ArrowDown'].includes(event.key)
            ? (index + 1) % visual.places.length
            : ['ArrowLeft', 'ArrowUp'].includes(event.key)
              ? (index - 1 + visual.places.length) % visual.places.length
              : undefined;
    if (next === undefined || event.altKey || event.ctrlKey || event.metaKey) return;
    event.preventDefault();
    event.stopPropagation();
    setSelected(visual.places[next]!.id);
    event.currentTarget
      .closest('[data-place-options]')
      ?.querySelector<HTMLButtonElement>(`[data-place-id="${visual.places[next]!.id}"]`)
      ?.focus();
  }

  return (
    <>
      <div className="places-toolbar">
        <span>
          <MapPin size={16} aria-hidden="true" />
          {visual.places.length} {visual.places.length === 1 ? 'place' : 'places'}
        </span>
        <div className="places-view" role="group" aria-label="Location view">
          <Button variant="ghost" size="sm" aria-pressed={!map} onClick={() => setMap(false)}>
            Overview
          </Button>
          <Button variant="ghost" size="sm" aria-pressed={map} onClick={() => setMap(true)}>
            Map
          </Button>
        </div>
      </div>
      <div className="places-layout">
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
              <div
                ref={plot}
                className="places-plot"
                aria-label="Relative location overview"
                data-place-options
              >
                {groups.map((group) => {
                  const { columns, x, y } = position(group);
                  return (
                    <div
                      key={group[0]!.item.id}
                      className={`place-marker-group${group.length > 1 ? ' is-cluster' : ''}`}
                      style={{
                        left: x,
                        top: y,
                        gridTemplateColumns: `repeat(${columns}, ${group.length === 1 ? 36 : 32}px)`,
                      }}
                    >
                      {group.map(({ item, index }) => (
                        <Tooltip key={item.id} content={item.name}>
                          <button
                            type="button"
                            className="place-pin"
                            data-place-id={item.id}
                            aria-label={`Show ${item.name}`}
                            aria-pressed={item.id === selected}
                            onClick={() => setSelected(item.id)}
                            onKeyDown={(event) => move(event, index)}
                          >
                            {index + 1}
                          </button>
                        </Tooltip>
                      ))}
                    </div>
                  );
                })}
              </div>
              <span className="places-map-label">Relative locations</span>
            </>
          )}
        </div>
        <ol className="places-list" aria-label="Places" data-place-options>
          {visual.places.map((item, index) => (
            <li key={item.id}>
              <button
                type="button"
                className="place-select"
                data-place-id={item.id}
                aria-pressed={item.id === selected}
                onClick={() => setSelected(item.id)}
                onKeyDown={(event) => move(event, index)}
              >
                <span className="place-index">{index + 1}</span>
                <span>
                  <strong>{item.name}</strong>
                  {item.description && <span>{item.description}</span>}
                </span>
              </button>
            </li>
          ))}
        </ol>
      </div>
      <div className="place-actions">
        <Tooltip content={place.name}>
          <span aria-live="polite">{place.name}</span>
        </Tooltip>
        <div className="place-links">
          {place.url && (
            <a
              href={place.url}
              target="_blank"
              rel="noopener noreferrer"
              referrerPolicy="no-referrer"
            >
              Source<span className="sr-only"> for {place.name}</span>
              <ExternalLink size={13} aria-hidden="true" />
            </a>
          )}
          <a
            href={mapLocationUrl(place)}
            target="_blank"
            rel="noopener noreferrer"
            referrerPolicy="no-referrer"
          >
            Open in Maps<span className="sr-only"> for {place.name}</span>
            <ExternalLink size={13} aria-hidden="true" />
          </a>
        </div>
      </div>
    </>
  );
}
