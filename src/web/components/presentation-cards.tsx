import { createContext, Fragment, useContext, useState, type ReactNode } from 'react';
import {
  compareColumn,
  draftSendLabel,
  mapLocationUrl,
  mapPoint,
  mapTileSize,
  type Presentation,
} from '../../shared/presentation';
import { AlertCircle, Check, ChevronDown, ExternalLink, LockKeyhole, Send } from './icons';

export interface CardPick {
  chosen: number[];
  written: string;
  multiple?: boolean;
  disabled: boolean;
  sent: boolean;
  closed?: boolean;
  label?: string;
  choose(index: number): void;
  write(text: string): void;
  send(fallback?: string): void;
}

export const CardPickContext = createContext<CardPick | null>(null);

const hostLabel = (link: string) => new URL(link).hostname.replace(/^www\./, '');

export function pickLinks(visual: Presentation) {
  if (visual.type === 'items') return visual.items.map(itemLink);
  if (visual.type === 'compare') return visual.columns.map((column) => compareColumn(column).url);
  return [];
}

export function CardPickSend({
  placeholder = 'Something else',
  action,
  links,
  children,
}: {
  placeholder?: string;
  action?: { label: string; icon?: ReactNode };
  links?: (string | undefined)[];
  children?: ReactNode;
}) {
  const pick = useContext(CardPickContext);
  const link = pick?.chosen.length === 1 ? links?.[pick.chosen[0]!] : undefined;
  const extra =
    children ??
    (link && (
      <a
        className="card-pick-open"
        href={link}
        target="_blank"
        rel="noopener noreferrer"
        referrerPolicy="no-referrer"
      >
        Open on {hostLabel(link)}
        <ExternalLink size={14} aria-hidden="true" />
      </a>
    ));
  if (pick?.closed)
    return (
      <div className="card-band card-pick-send" data-closed>
        <p className="card-pick-closed">
          <LockKeyhole size={13} aria-hidden="true" />
          Read only · this choice has closed
        </p>
        {extra}
      </div>
    );
  const open = pick && !pick.sent;
  if (!open && !extra) return null;
  const written = pick?.written.trim() ?? '';
  const idle = !open || pick.disabled || (!written && !action && !pick.chosen.length);
  const send = () => {
    if (!idle) pick.send(written || pick.chosen.length ? undefined : action?.label);
  };
  return (
    <div className="card-band card-pick-send">
      {open && (
        <>
          <input
            className="card-pick-write"
            value={pick.written}
            maxLength={4000}
            placeholder={placeholder}
            aria-label={placeholder}
            readOnly={pick.disabled}
            onChange={(event) => pick.write(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
              event.preventDefault();
              send();
            }}
          />
          <button
            type="button"
            className="choice-card-done"
            aria-disabled={idle || undefined}
            onClick={send}
          >
            {written || pick.multiple ? (
              'Send'
            ) : action ? (
              <>
                {action.icon}
                {action.label}
              </>
            ) : pick.label ? (
              `Choose ${pick.label}`
            ) : (
              'Choose one'
            )}
          </button>
        </>
      )}
      {extra}
    </div>
  );
}

type Visual<T extends Presentation['type']> = Extract<Presentation, { type: T }>;
type Item = Visual<'items'>['items'][number];
type Located = Item & { location: NonNullable<Item['location']> };

export function CardHead({
  visual,
}: {
  visual: Visual<'items' | 'schedule' | 'facts' | 'compare'>;
}) {
  return (
    <header className="card-head">
      <strong>{visual.title}</strong>
      {visual.type === 'facts' && visual.status && (
        <em className="card-status" data-tone={visual.status.tone}>
          {visual.status.label}
        </em>
      )}
    </header>
  );
}

export function CardNote({ note }: { note?: string }) {
  return note ? <p className="card-band card-note">{note}</p> : null;
}

function Chips({ badge, tags }: { badge?: string; tags?: string[] }) {
  if (!badge && !tags?.length) return null;
  return (
    <span className="card-chips">
      {badge && <span className="card-badge">{badge}</span>}
      {tags?.map((tag, index) => (
        <span key={index} className="card-tag">
          {tag}
        </span>
      ))}
    </span>
  );
}

function Choosable({
  index,
  className,
  pick,
  onChoose,
  children,
}: {
  index: number;
  className: string;
  pick: CardPick;
  onChoose?(): void;
  children: ReactNode;
}) {
  const chosen = pick.chosen.includes(index);
  const locked = pick.disabled || pick.sent;
  return (
    <button
      type="button"
      className={className}
      data-choice
      aria-pressed={chosen}
      aria-disabled={locked || undefined}
      onClick={() => {
        if (locked) return;
        pick.choose(index);
        onChoose?.();
      }}
    >
      {children}
    </button>
  );
}

function Picture({
  item,
  className,
  keepSpace,
  logo,
}: {
  item: { image?: Item['image'] };
  className: string;
  keepSpace?: boolean;
  logo?: boolean;
}) {
  const [failed, setFailed] = useState(false);
  if (!item.image || typeof item.image !== 'object' || failed)
    return keepSpace ? (
      <span className={className} data-logo={logo || undefined} aria-hidden="true" />
    ) : null;
  return (
    <img
      className={className}
      data-logo={logo || undefined}
      src={`/api/artifacts/${item.image.artifactId}`}
      alt={item.image.alt}
      loading="lazy"
      draggable={false}
      onError={() => setFailed(true)}
    />
  );
}

const pictured = (item: Item) => Boolean(item.image && typeof item.image === 'object');
const itemLink = (item: Item) => item.url ?? (item.location && mapLocationUrl(item.location));

function Tiles({ visual }: { visual: Visual<'items'> }) {
  const pick = useContext(CardPickContext);
  const located = visual.items.every((item) => item.location) ? (visual.items as Located[]) : null;
  const [selected, setSelected] = useState(0);
  const gallery = visual.items.some(pictured);
  return (
    <div className="card-band">
      {located && (
        <Pins items={located} map={visual.map} selected={selected} onSelect={setSelected} />
      )}
      <ul
        className="card-tiles"
        data-settled={pick?.sent || undefined}
        data-closed={pick?.closed || undefined}
        data-count={visual.items.length % 3 === 0 || visual.items.length === 5 ? 3 : 2}
        data-pictured={gallery || undefined}
      >
        {visual.items.map((item, index) => {
          const link = itemLink(item);
          const body = (
            <>
              <Picture item={item} className="card-tile-image" keepSpace={gallery} />
              <span className="card-tile-top">
                {(visual.ranked || located) && <span className="card-rank">{index + 1}</span>}
                {item.badge && <span className="card-badge">{item.badge}</span>}
                {pick && (
                  <span className="card-radio" data-on={pick.chosen.includes(index) || undefined}>
                    {pick.chosen.includes(index) && <Check size={12} aria-hidden="true" />}
                  </span>
                )}
              </span>
              <span className="card-title">{item.title}</span>
              {item.sub && <span className="card-sub">{item.sub}</span>}
              {item.detail && <span className="card-tile-detail">{item.detail}</span>}
              {item.tags && <Chips tags={item.tags} />}
              {item.value && (
                <span className="card-tile-value">
                  {item.value}
                  {item.valueSub && <small>{item.valueSub}</small>}
                </span>
              )}
            </>
          );
          return (
            <li
              key={index}
              data-badge={item.badge ? true : undefined}
              data-chosen={pick?.chosen.includes(index) || undefined}
              data-selected={(located && selected === index) || undefined}
              onPointerEnter={located ? () => setSelected(index) : undefined}
            >
              {pick ? (
                <Choosable index={index} className="card-tile" pick={pick}>
                  {body}
                </Choosable>
              ) : link ? (
                <a
                  className="card-tile"
                  href={link}
                  target="_blank"
                  rel="noopener noreferrer"
                  referrerPolicy="no-referrer"
                >
                  {body}
                </a>
              ) : (
                <div className="card-tile">{body}</div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function Items({ visual }: { visual: Visual<'items'> }) {
  const count = visual.items.length;
  const simple = visual.items.every(
    (item) =>
      item.value &&
      !item.status &&
      !item.route &&
      !item.location &&
      !item.warning &&
      (item.detail?.length ?? 0) <= 160 &&
      !item.facts?.length &&
      !item.journeys,
  );
  const gallery =
    visual.items.filter(pictured).length >= Math.max(2, count - 1) &&
    visual.items.every(
      (item) => !item.status && !item.route && !item.facts?.length && !item.journeys,
    );
  if (
    visual.layout !== 'list' &&
    count > 1 &&
    (visual.layout === 'tiles'
      ? count <= 6 &&
        visual.items.every(
          (item) =>
            !item.status && !item.route && !item.warning && !item.facts?.length && !item.journeys,
        )
      : (count <= 4 && simple) || (count <= 6 && gallery))
  )
    return <Tiles visual={visual} />;
  return <List visual={visual} />;
}

function List({ visual }: { visual: Visual<'items'> }) {
  const located = visual.items.every((item) => item.location) ? (visual.items as Located[]) : null;
  const [open, setOpen] = useState<number | null>(null);
  const [selected, setSelected] = useState(0);
  const pick = useContext(CardPickContext);
  const dots = visual.items.some((item) => item.status);
  const pinned = Boolean(located && located.length > 1);
  const gutter = pick ? 'choice' : dots ? 'dot' : pinned || visual.ranked ? 'index' : undefined;
  const usualDate = mostCommon(visual.items.map((item) => item.route?.from.note));
  const hasImages = visual.items.some(pictured);
  return (
    <div className="card-band">
      {visual.label && <p className="card-label">{visual.label}</p>}
      {located && located.length > 1 && (
        <Pins items={located} map={visual.map} selected={selected} onSelect={setSelected} />
      )}
      <ul
        className="card-items"
        data-gutter={gutter}
        data-pictured={hasImages || undefined}
        data-settled={pick?.sent || undefined}
        data-closed={pick?.closed || undefined}
      >
        {visual.items.map((item, index) => {
          const expandable = Boolean(item.detail || item.facts || item.journeys);
          const link = itemLink(item);
          const chosen = pick?.chosen.includes(index);
          const row = (
            <>
              {gutter === 'choice' && (
                <span className="card-radio" data-on={chosen || undefined}>
                  {chosen && <Check size={12} aria-hidden="true" />}
                </span>
              )}
              {gutter === 'dot' && (
                <span className="card-dot" data-tone={item.status?.tone ?? 'none'} />
              )}
              {gutter === 'index' && <span className="card-index">{index + 1}</span>}
              <Picture
                item={item}
                className="card-thumb"
                keepSpace={hasImages}
                logo={Boolean(item.route)}
              />
              <span className="card-main">
                {item.route ? (
                  <RouteLine item={item} usualDate={usualDate} />
                ) : (
                  <>
                    <span className="card-title-line">
                      <span className="card-title">{item.title}</span>
                      {item.badge && <span className="card-badge">{item.badge}</span>}
                    </span>
                    {(item.status || item.sub) && (
                      <span className="card-sub">
                        {item.status && (
                          <span className="card-row-status">{item.status.label}</span>
                        )}
                        {item.status && item.sub && ' · '}
                        {item.sub}
                      </span>
                    )}
                    {item.tags && <Chips tags={item.tags} />}
                  </>
                )}
                {item.warning && (
                  <span className="card-warning">
                    <AlertCircle size={13} aria-hidden="true" />
                    {item.warning}
                  </span>
                )}
              </span>
              {item.value && (
                <span className="card-value">
                  {item.value}
                  {item.valueSub && <small>{item.valueSub}</small>}
                </span>
              )}
              {pick ? null : expandable ? (
                <ChevronDown size={14} className="card-chevron" aria-hidden="true" />
              ) : (
                link && <ExternalLink size={13} className="card-chevron" aria-hidden="true" />
              )}
            </>
          );
          const toggle = (
            <button
              type="button"
              className="card-toggle"
              aria-expanded={open === index}
              aria-label={open === index ? 'Hide details' : 'Show details'}
              onClick={() => setOpen(open === index ? null : index)}
            >
              <ChevronDown size={14} aria-hidden="true" />
            </button>
          );
          return (
            <li
              key={index}
              data-open={open === index || undefined}
              data-tall={item.route || item.tags ? true : undefined}
              data-chosen={chosen || undefined}
              data-selected={(located && selected === index) || undefined}
              onPointerEnter={located ? () => setSelected(index) : undefined}
            >
              {pick ? (
                <span className="card-row-pick">
                  <Choosable
                    index={index}
                    className="card-row"
                    pick={pick}
                    onChoose={expandable ? () => setOpen(index) : undefined}
                  >
                    {row}
                  </Choosable>
                  {expandable && toggle}
                </span>
              ) : expandable ? (
                <button
                  type="button"
                  className="card-row"
                  aria-expanded={open === index}
                  onClick={() => setOpen(open === index ? null : index)}
                >
                  {row}
                </button>
              ) : link ? (
                <a
                  className="card-row"
                  href={link}
                  target="_blank"
                  rel="noopener noreferrer"
                  referrerPolicy="no-referrer"
                >
                  {row}
                </a>
              ) : (
                <div className="card-row">{row}</div>
              )}
              {open === index && (
                <div className="card-detail">
                  {item.detail && <p>{item.detail}</p>}
                  {item.journeys?.map((journey, index) => (
                    <Journey key={index} journey={journey} />
                  ))}
                  {item.facts && <Facts items={item.facts} />}
                  {link && !(pick?.chosen.length === 1 && pick.chosen[0] === index) && (
                    <a
                      className="button button-outline button-sm card-open"
                      href={link}
                      target="_blank"
                      rel="noopener noreferrer"
                      referrerPolicy="no-referrer"
                    >
                      Open on {hostLabel(link)}
                      <ExternalLink size={13} aria-hidden="true" />
                    </a>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function mostCommon(values: Array<string | undefined>) {
  const counts = new Map<string, number>();
  for (const value of values) if (value) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
}

function RouteLine({ item, usualDate }: { item: Item; usualDate?: string }) {
  const route = item.route!;
  const timed = Boolean(route.from.time && route.to.time);
  const nextDay = Boolean(route.to.note && route.from.note && route.to.note !== route.from.note);
  const otherDate = route.from.note && route.from.note !== usualDate ? route.from.note : undefined;
  const places = `${route.from.place} → ${route.to.place}`;
  const via = route.middle && !item.valueSub ? `via ${route.middle.join(', ')}` : undefined;
  return (
    <>
      <span className="card-title-line">
        <span className="card-times">
          {timed ? (
            <>
              {route.from.time}
              <span className="card-dash"> – </span>
              {route.to.time}
              {nextDay && <sup>+1</sup>}
            </>
          ) : (
            places
          )}
        </span>
        {item.badge && <span className="card-badge">{item.badge}</span>}
      </span>
      <span className="card-sub">
        {[otherDate, item.title, timed ? places : undefined, via, route.duration, item.sub]
          .filter(Boolean)
          .join(' · ')}
      </span>
      {route.stops?.map((stop, index) => (
        <span className="card-stop" key={index}>
          {stop.label} · <b>{stop.place}</b>
          {stop.detail && ` · ${stop.detail}`}
        </span>
      ))}
    </>
  );
}

function Pins({
  items,
  map,
  selected,
  onSelect,
}: {
  items: Located[];
  map?: Visual<'items'>['map'];
  selected: number;
  onSelect: (index: number) => void;
}) {
  const [broken, setBroken] = useState(false);
  if (map && !broken) {
    const rows = Math.ceil(map.tiles.length / map.columns);
    const width = map.columns * mapTileSize;
    const height = rows * mapTileSize;
    return (
      <div className="card-map" style={{ aspectRatio: `${width} / ${height}` }}>
        <div
          className="card-map-tiles"
          style={{ gridTemplateColumns: `repeat(${map.columns}, 1fr)` }}
        >
          {map.tiles.map((tile) => (
            <img
              key={tile.artifactId}
              src={`/api/artifacts/${tile.artifactId}`}
              alt=""
              draggable={false}
              onError={() => setBroken(true)}
            />
          ))}
        </div>
        {items.map((item, index) => {
          const point = mapPoint(item.location, map.zoom, map.x);
          return (
            <button
              key={index}
              type="button"
              className="card-map-pin"
              aria-label={`Show ${item.title}`}
              aria-pressed={selected === index}
              style={{
                left: `${((point.x - map.x * mapTileSize) / width) * 100}%`,
                top: `${((point.y - map.y * mapTileSize) / height) * 100}%`,
              }}
              onClick={() => onSelect(index)}
            >
              {index + 1}
            </button>
          );
        })}
        <a
          className="card-map-credit"
          href="https://www.openstreetmap.org/copyright"
          target="_blank"
          rel="noopener noreferrer"
          referrerPolicy="no-referrer"
        >
          © OpenStreetMap
        </a>
      </div>
    );
  }
  const lat = items.map((item) => item.location.latitude);
  const lon = items.map((item) => item.location.longitude);
  const midLat = (Math.min(...lat) + Math.max(...lat)) / 2;
  const midLon = (Math.min(...lon) + Math.max(...lon)) / 2;
  const squash = Math.cos((midLat * Math.PI) / 180);
  const span = Math.max(
    (Math.max(...lon) - Math.min(...lon)) * squash,
    Math.max(...lat) - Math.min(...lat),
    0.001,
  );
  return (
    <div className="card-plot">
      <div className="places-plot">
        {items.map((item, index) => (
          <div
            key={index}
            className="place-marker-group"
            style={{
              left: `${50 + (((item.location.longitude - midLon) * squash) / span) * 70}%`,
              top: `${50 - ((item.location.latitude - midLat) / span) * 70}%`,
            }}
          >
            <button
              type="button"
              className="place-pin"
              aria-label={`Show ${item.title}`}
              aria-pressed={selected === index}
              onClick={() => onSelect(index)}
            >
              {index + 1}
            </button>
          </div>
        ))}
      </div>
      <span className="places-map-label">Relative locations</span>
    </div>
  );
}

export function Schedule({ visual }: { visual: Visual<'schedule'> }) {
  const days: Array<{ day?: string; items: Visual<'schedule'>['items'] }> = [];
  for (const item of visual.items) {
    const last = days.at(-1);
    if (last && (item.day === undefined || item.day === last.day)) last.items.push(item);
    else days.push({ day: item.day, items: [item] });
  }
  return (
    <div className="card-band">
      {days.map((group, groupIndex) => (
        <section key={groupIndex} className="card-day">
          {group.day && <p className="card-label">{group.day}</p>}
          <ScheduleItems items={group.items} />
        </section>
      ))}
    </div>
  );
}

function ScheduleItems({ items }: { items: Visual<'schedule'>['items'] }) {
  return (
    <ol className="card-schedule">
      {items.map((item, index) => (
        <li key={index} data-quiet={item.quiet || undefined}>
          <span className="card-time">
            {item.start}
            {item.end && <small>{item.end}</small>}
          </span>
          <span className="card-bar" data-clash={item.clash || undefined} />
          <span className="card-main">
            <span className="card-title">{item.title}</span>
            {item.detail && <small>{item.detail}</small>}
          </span>
        </li>
      ))}
    </ol>
  );
}

function Journey({ journey }: { journey: NonNullable<Item['journeys']>[number] }) {
  return (
    <section className="card-journey">
      <header>
        <span>{journey.label}</span>
        {journey.summary && <small>{journey.summary}</small>}
      </header>
      <ol>
        {journey.legs.map((leg, index) => {
          const date = index === 0 || leg.from.note !== journey.legs[index - 1]!.to.note;
          return (
            <Fragment key={index}>
              <li data-kind="stop">
                <time>{leg.from.time}</time>
                <b>{leg.from.place}</b>
                {date && leg.from.note && <small>{leg.from.note}</small>}
              </li>
              <li data-kind="leg">
                <span>
                  {leg.name}
                  {leg.detail && <small> · {leg.detail}</small>}
                </span>
              </li>
              <li data-kind="stop">
                <time>{leg.to.time}</time>
                <b>{leg.to.place}</b>
                {leg.to.note && leg.to.note !== leg.from.note && <small>{leg.to.note}</small>}
              </li>
              {leg.after && (
                <li data-kind="wait">
                  <span>{leg.after}</span>
                </li>
              )}
            </Fragment>
          );
        })}
      </ol>
    </section>
  );
}

function Facts({ items }: { items: Array<{ label: string; value: string; strong?: boolean }> }) {
  return (
    <dl className="card-facts">
      {items.map((item, index) => (
        <div key={index} data-strong={item.strong || undefined}>
          <dt>{item.label}</dt>
          <dd>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function Stats({ items }: { items: NonNullable<Visual<'facts'>['stats']> }) {
  return (
    <dl className="card-stats" data-count={items.length}>
      {items.map((item, index) => (
        <div key={index}>
          <dt>{item.label}</dt>
          <dd>{item.value}</dd>
          {item.sub && <dd className="card-stat-sub">{item.sub}</dd>}
        </div>
      ))}
    </dl>
  );
}

export function FactList({ visual }: { visual: Visual<'facts'> }) {
  return (
    <>
      {visual.stats && (
        <div className="card-band">
          <Stats items={visual.stats} />
        </div>
      )}
      {visual.items?.length ? (
        <div className="card-band">
          <Facts items={visual.items} />
        </div>
      ) : null}
    </>
  );
}

export function Compare({ visual }: { visual: Visual<'compare'> }) {
  const winner = visual.winner;
  const columns = visual.columns.map(compareColumn);
  const pick = useContext(CardPickContext);
  return (
    <>
      {visual.verdict && <p className="card-band card-verdict">{visual.verdict}</p>}
      <div className="card-band">
        <div className="card-compare-scroll">
          <table
            className="card-compare"
            data-columns={visual.columns.length}
            data-settled={pick?.sent || undefined}
            data-closed={pick?.closed || undefined}
          >
            <thead>
              <tr>
                <td />
                {columns.map((column, index) => {
                  const chosen = pick?.chosen.includes(index) ?? false;
                  const body = (
                    <>
                      <Picture
                        item={column}
                        className="card-contender-image"
                        keepSpace={columns.some((other) => other.image)}
                      />
                      <span className="card-contender-text">
                        <span className="card-title">
                          {column.url && !pick ? (
                            <a
                              href={column.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              referrerPolicy="no-referrer"
                            >
                              {column.label}
                            </a>
                          ) : (
                            column.label
                          )}
                        </span>
                        {column.sub && <span className="card-sub">{column.sub}</span>}
                      </span>
                      {winner === index && <span className="card-pick">Pick</span>}
                      {pick && (
                        <span className="card-radio" data-on={chosen || undefined}>
                          {chosen && <Check size={12} aria-hidden="true" />}
                        </span>
                      )}
                    </>
                  );
                  return (
                    <th
                      key={index}
                      scope="col"
                      data-winner={winner === index || undefined}
                      data-chosen={chosen || undefined}
                    >
                      {pick ? (
                        <Choosable index={index} className="card-contender" pick={pick}>
                          {body}
                        </Choosable>
                      ) : (
                        <span className="card-contender">{body}</span>
                      )}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {visual.rows.map((row, rowIndex) => {
                const largest = Math.max(0, ...(row.amounts ?? []));
                return (
                  <tr key={rowIndex}>
                    <th scope="row">{row.label}</th>
                    {row.values.map((value, index) => (
                      <td
                        key={index}
                        data-best={row.best === index || undefined}
                        data-winner={winner === index || undefined}
                      >
                        <span className="card-cell">
                          {row.best === index && (
                            <Check size={12} className="card-best" aria-label="Better" />
                          )}
                          {value}
                        </span>
                        {row.amounts && largest > 0 && (
                          <span className="card-barline" aria-hidden="true">
                            <i style={{ width: `${(row.amounts[index]! / largest) * 100}%` }} />
                          </span>
                        )}
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

const draftStatus = { draft: 'Draft · not sent', sent: 'Sent', scheduled: 'Scheduled' } as const;

export function Draft({ visual }: { visual: Visual<'draft'> }) {
  const people = [
    ['From', visual.from ? [visual.from] : undefined],
    ['To', visual.to],
    ['Cc', visual.cc],
  ] as const;
  return (
    <>
      <header className="card-head card-draft-head">
        <strong>{visual.subject || visual.title}</strong>
        <em className="card-status" data-tone={visual.status === 'draft' ? undefined : 'done'}>
          {draftStatus[visual.status]}
          {visual.when ? ` · ${visual.when}` : ''}
        </em>
      </header>
      <div className="card-band">
        <Facts
          items={people.flatMap(([label, values]) =>
            values ? [{ label, value: values.join(', ') }] : [],
          )}
        />
      </div>
      <div className="card-band card-draft-body">{visual.body}</div>
      {visual.attachments && (
        <div className="card-band">
          <Chips tags={visual.attachments} />
        </div>
      )}
      <CardPickSend
        placeholder="Ask for a change"
        action={{ label: draftSendLabel, icon: <Send size={14} aria-hidden="true" /> }}
      >
        {visual.open && (
          <a
            className="card-pick-open"
            href={visual.open}
            target="_blank"
            rel="noopener noreferrer"
            referrerPolicy="no-referrer"
          >
            Open{visual.via ? ` in ${visual.via}` : ''}
            <ExternalLink size={14} aria-hidden="true" />
          </a>
        )}
      </CardPickSend>
    </>
  );
}
