import { useEffect, useId, useRef, useState } from 'react';
import { flightJourneySummary, type Presentation } from '../../shared/presentation';
import { AlertCircle, ArrowRight, Check, ChevronDown, ExternalLink, Plane } from './icons';

type FlightsVisual = Extract<Presentation, { type: 'flights' }>;
type SeatsVisual = Extract<Presentation, { type: 'seats' }>;
type Journey = FlightsVisual['options'][number]['journeys'][number];

function FlightAirport({
  point,
  compact = false,
}: {
  point: Journey['segments'][number]['departure'];
  compact?: boolean;
}) {
  return (
    <div className="flight-airport">
      <strong>{point.time}</strong>
      <span className="flight-airport-code">{point.airport}</span>
      {point.date && <span>{point.date}</span>}
      {!compact && point.terminal && <span>Terminal {point.terminal}</span>}
      {!compact && point.timeZone && <small>{point.timeZone}</small>}
    </div>
  );
}

function JourneyStops({ journey }: { journey: Journey }) {
  const stops = journey.segments.flatMap((segment, index) => [
    ...(segment.technicalStops ?? []).map((stop) => ({
      airport: stop.airport,
      duration: stop.duration,
      type: 'Technical stop',
    })),
    ...(segment.connectionAfter
      ? [
          {
            airport:
              segment.arrival.airport === journey.segments[index + 1]!.departure.airport
                ? segment.arrival.airport
                : `${segment.arrival.airport} → ${journey.segments[index + 1]!.departure.airport}`,
            duration: segment.connectionAfter.duration,
            type: segment.connectionAfter.airportChange === 'yes' ? 'Airport change' : 'Connection',
          },
        ]
      : []),
  ]);
  if (!stops.length) return null;
  return (
    <ul className="flight-summary-stops" aria-label={`${journey.label} stops`}>
      {stops.map((stop, index) => (
        <li key={index}>
          <span className="flight-stop-kind">{stop.type}</span>
          <strong>{stop.airport}</strong>
          <span>{stop.duration || 'Duration not supplied'}</span>
        </li>
      ))}
    </ul>
  );
}

export function Flights({ visual }: { visual: FlightsVisual }) {
  return (
    <div className="flight-options">
      {visual.options.map((flight, optionIndex) => {
        const airlines = [
          ...new Set(
            flight.journeys.flatMap((journey) =>
              journey.segments.map((segment) => segment.airline),
            ),
          ),
        ];
        const connections = flight.journeys.flatMap((journey) =>
          journey.segments.flatMap((segment, index) =>
            segment.connectionAfter
              ? [
                  {
                    ...segment.connectionAfter,
                    from: segment.arrival.airport,
                    to: journey.segments[index + 1]!.departure.airport,
                  },
                ]
              : [],
          ),
        );
        const warnings = [
          ...new Set(
            connections.flatMap((connection) =>
              [
                connection.airportChange === 'yes'
                  ? `Airport change: ${connection.from} → ${connection.to}`
                  : undefined,
                connection.selfTransfer === 'yes' ? 'Self-transfer' : undefined,
                connection.airportChange === 'unknown' || connection.selfTransfer === 'unknown'
                  ? 'Transfer details not supplied'
                  : undefined,
              ].filter((value): value is string => Boolean(value)),
            ),
          ),
        ];
        const incompleteTimes = flight.journeys.some((journey) =>
          journey.segments.some(
            (segment) =>
              !segment.departure.date ||
              !segment.arrival.date ||
              !segment.departure.timeZone ||
              !segment.arrival.timeZone,
          ),
        );
        return (
          <details
            className={`flight-option${flight.recommended ? ' is-recommended' : ''}`}
            key={flight.id}
          >
            <summary>
              <div className="flight-overview">
                <div className="flight-topline">
                  <div className="flight-identity">
                    <div className="flight-option-label">
                      <span>Option {optionIndex + 1}</span>
                      {flight.recommended && <span className="presentation-tag">Recommended</span>}
                    </div>
                    <span className="flight-airline">
                      <Plane size={18} aria-hidden="true" />
                      <span>{flight.label || airlines.join(' + ')}</span>
                    </span>
                  </div>
                  <strong className="flight-price">{flight.price}</strong>
                </div>
                {flight.journeys.map((journey) => (
                  <div className="flight-summary-journey" key={journey.id}>
                    <div className="flight-journey-heading">
                      <span className="flight-journey-label">{journey.label}</span>
                      {journey.duration && <span>{journey.duration}</span>}
                    </div>
                    <div className="flight-route">
                      <FlightAirport point={journey.segments[0]!.departure} compact />
                      <div className="flight-journey">
                        <span className="flight-track" aria-hidden="true">
                          <i />
                          <ArrowRight size={18} />
                        </span>
                        <span>{flightJourneySummary(journey)}</span>
                      </div>
                      <FlightAirport point={journey.segments.at(-1)!.arrival} compact />
                    </div>
                    <JourneyStops journey={journey} />
                  </div>
                ))}
                {warnings.length > 0 && (
                  <div className="flight-warnings">
                    <AlertCircle size={16} aria-hidden="true" />
                    <span>{warnings.join(' · ')}</span>
                  </div>
                )}
                {incompleteTimes && (
                  <p className="flight-time-note">Some dates or time zones were not supplied.</p>
                )}
              </div>
              <span className="flight-details-toggle">
                <span className="flight-toggle-closed">View option {optionIndex + 1} details</span>
                <span className="flight-toggle-open">Hide option {optionIndex + 1} details</span>
                <ChevronDown size={18} aria-hidden="true" />
              </span>
            </summary>
            <div className="flight-details">
              {flight.journeys.map((journey) => (
                <section className="flight-itinerary" key={journey.id} aria-label={journey.label}>
                  <h4>{journey.label}</h4>
                  <ol className="flight-segments">
                    {journey.segments.map((segment, index) => (
                      <li key={index}>
                        <div className="flight-segment-heading">
                          <strong>
                            {[segment.airline, segment.flightNumber].filter(Boolean).join(' · ')}
                          </strong>
                          {segment.duration && <span>{segment.duration}</span>}
                        </div>
                        {segment.operatedBy && (
                          <p className="flight-segment-meta">Operated by {segment.operatedBy}</p>
                        )}
                        <div className="flight-segment-route">
                          <FlightAirport point={segment.departure} />
                          <ArrowRight size={18} aria-hidden="true" />
                          <FlightAirport point={segment.arrival} />
                        </div>
                        {(segment.aircraft || segment.cabin) && (
                          <p className="flight-segment-meta">
                            {[segment.aircraft, segment.cabin].filter(Boolean).join(' · ')}
                          </p>
                        )}
                        {segment.technicalStops?.map((stop, stopIndex) => (
                          <div className="flight-stop" key={stopIndex}>
                            <strong>Technical stop · {stop.airport}</strong>
                            <span>{stop.duration || 'Duration not supplied'}</span>
                            {stop.details && <p>{stop.details}</p>}
                          </div>
                        ))}
                        {segment.technicalStops === undefined && (
                          <p className="flight-segment-meta">
                            Technical stop details not supplied.
                          </p>
                        )}
                        {segment.connectionAfter && (
                          <div
                            className={`flight-connection${segment.connectionAfter.airportChange === 'yes' || segment.connectionAfter.selfTransfer === 'yes' ? ' has-risk' : ''}`}
                          >
                            <strong>
                              Connection · {segment.arrival.airport}
                              {segment.arrival.airport !==
                                journey.segments[index + 1]!.departure.airport &&
                                ` → ${journey.segments[index + 1]!.departure.airport}`}
                            </strong>
                            <span>
                              {segment.connectionAfter.duration || 'Duration not supplied'}
                            </span>
                            {segment.connectionAfter.airportChange === 'yes' && (
                              <p>
                                Airport change: {segment.arrival.airport} →{' '}
                                {journey.segments[index + 1]!.departure.airport}
                              </p>
                            )}
                            {segment.connectionAfter.airportChange === 'unknown' && (
                              <p>Airport transfer details not supplied.</p>
                            )}
                            {segment.connectionAfter.selfTransfer === 'yes' && <p>Self-transfer</p>}
                            {segment.connectionAfter.selfTransfer === 'unknown' && (
                              <p>Self-transfer status not supplied.</p>
                            )}
                            {segment.connectionAfter.details && (
                              <p>{segment.connectionAfter.details}</p>
                            )}
                          </div>
                        )}
                      </li>
                    ))}
                  </ol>
                </section>
              ))}
              <div className="flight-fare-details">
                <dl>
                  <div>
                    <dt>Baggage</dt>
                    <dd>{flight.baggage || 'Not provided'}</dd>
                  </div>
                </dl>
                {flight.url && (
                  <a
                    href={flight.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    referrerPolicy="no-referrer"
                  >
                    View option {optionIndex + 1} <ExternalLink size={14} aria-hidden="true" />
                  </a>
                )}
              </div>
            </div>
          </details>
        );
      })}
      <p className="presentation-footnote">
        Prices and availability can change. Opening an option does not book it.
      </p>
    </div>
  );
}

export function Seats({ visual }: { visual: SeatsVisual }) {
  const seats = visual.sections.flatMap((section) =>
    section.rows.flatMap((row) =>
      row.groups.flatMap((group) => group.flatMap((seat) => (seat ? [{ seat, section }] : []))),
    ),
  );
  const [selected, setSelected] = useState(
    visual.recommended ?? {
      sectionId: seats[0]!.section.id,
      seatLabel: seats[0]!.seat.label,
    },
  );
  const [sectionFilter, setSectionFilter] = useState<string | null>(
    visual.recommended?.sectionId ?? null,
  );
  const current = seats.find(
    ({ seat, section }) => section.id === selected.sectionId && seat.label === selected.seatLabel,
  )!;
  const recommended =
    visual.recommended?.sectionId === current.section.id &&
    visual.recommended.seatLabel === current.seat.label;
  const detailId = useId();
  const sectionId = useId();
  const planId = useId();
  const planRef = useRef<HTMLDivElement>(null);
  const shown = visual.sections.filter(
    (section) => sectionFilter === null || section.id === sectionFilter,
  );
  const rowCount = visual.sections.reduce((total, section) => total + section.rows.length, 0);
  const shownRowCount = shown.reduce((total, section) => total + section.rows.length, 0);
  const shownSeatCount = seats.filter(
    ({ section }) => sectionFilter === null || section.id === sectionFilter,
  ).length;
  const coverage =
    visual.coverage?.scope === 'full-aircraft'
      ? 'Full aircraft'
      : visual.coverage?.scope === 'cabin'
        ? 'Cabin map'
        : visual.coverage?.scope === 'selection'
          ? 'Selected rows'
          : 'Supplied rows';
  useEffect(() => {
    const plan = planRef.current;
    const seat = plan?.querySelector<HTMLButtonElement>('.seat[aria-pressed="true"]');
    if (!plan || !seat) return;
    const viewport = plan.getBoundingClientRect();
    const target = seat.getBoundingClientRect();
    if (target.top < viewport.top) plan.scrollTop += target.top - viewport.top - 16;
    else if (target.bottom > viewport.bottom)
      plan.scrollTop += target.bottom - viewport.bottom + 16;
    if (target.left < viewport.left) plan.scrollLeft += target.left - viewport.left - 16;
    else if (target.right > viewport.right) plan.scrollLeft += target.right - viewport.right + 16;
  }, [sectionFilter, selected]);
  function showSection(id: string | null) {
    setSectionFilter(id);
    if (id && id !== selected.sectionId) {
      const next =
        seats.find(
          ({ section, seat }) =>
            section.id === id &&
            section.id === visual.recommended?.sectionId &&
            seat.label === visual.recommended.seatLabel,
        ) ?? seats.find(({ section }) => section.id === id)!;
      setSelected({ sectionId: id, seatLabel: next.seat.label });
    }
  }
  return (
    <>
      <div className="seat-context">
        <div>
          <Plane size={18} aria-hidden="true" />
          <strong>{visual.aircraft || 'Seat plan'}</strong>
          <span>Schematic</span>
        </div>
        {visual.flight && <p>{visual.flight}</p>}
      </div>
      <div className="seat-coverage">
        <div>
          <strong>{coverage}</strong>
          <span>
            {shownRowCount}
            {sectionFilter !== null && ` of ${rowCount}`} rows · {shownSeatCount}
            {sectionFilter !== null && ` of ${seats.length}`} seats shown
          </span>
        </div>
        <p>
          {visual.coverage?.description ||
            'Only the supplied rows are shown. Other rows or cabins may not be included.'}
        </p>
      </div>
      {visual.sections.length > 1 && (
        <div
          className="seat-section-controls"
          role="group"
          aria-label="Cabin and deck"
          aria-controls={planId}
        >
          <button
            type="button"
            aria-pressed={sectionFilter === null}
            aria-controls={planId}
            onClick={() => showSection(null)}
          >
            All sections
          </button>
          {visual.sections.map((section) => (
            <button
              type="button"
              key={section.id}
              aria-pressed={sectionFilter === section.id}
              aria-controls={planId}
              onClick={() => showSection(section.id)}
            >
              <span>{section.name}</span>
              {section.deck && <small>{section.deck}</small>}
            </button>
          ))}
        </div>
      )}
      <div className="seat-legend">
        <span>
          <i className="is-available" />
          Available
        </span>
        <span>
          <i className="is-unavailable" />
          Unavailable
        </span>
        <span>
          <i className="is-unknown" />
          Unknown
        </span>
      </div>
      <div className="seat-layout">
        <div
          className="seat-plan-scroll"
          id={planId}
          ref={planRef}
          tabIndex={0}
          role="region"
          aria-label="Seat plan"
        >
          <div className="seat-plan">
            {shown.map((section, index) => (
              <section
                className="seat-section"
                key={section.id}
                aria-labelledby={`${sectionId}-${index}`}
              >
                <header className="seat-section-header">
                  <h4 id={`${sectionId}-${index}`}>{section.name}</h4>
                  {section.deck && <span>{section.deck}</span>}
                  <small>
                    {section.rows.length} {section.rows.length === 1 ? 'row' : 'rows'} shown
                  </small>
                </header>
                <div className="seat-rows">
                  {section.rows.map((row) => (
                    <div
                      className="seat-row"
                      key={row.label}
                      role="group"
                      aria-label={`Row ${row.label}`}
                    >
                      <span className="seat-row-label" aria-hidden="true">
                        {row.label}
                      </span>
                      <div className="seat-row-groups">
                        {row.groups.map((group, groupIndex) => (
                          <div
                            className="seat-group"
                            key={groupIndex}
                            role="group"
                            aria-label={`Seat group ${groupIndex + 1} of ${row.groups.length}`}
                          >
                            {group.map((item, index) => {
                              if (!item)
                                return (
                                  <span className="seat-empty" key={index} aria-hidden="true" />
                                );
                              const active =
                                selected.sectionId === section.id &&
                                selected.seatLabel === item.label;
                              const suggested =
                                visual.recommended?.sectionId === section.id &&
                                visual.recommended.seatLabel === item.label;
                              return (
                                <button
                                  key={item.label}
                                  type="button"
                                  className={`seat is-${item.status}${suggested ? ' is-recommended' : ''}`}
                                  aria-label={`Seat ${item.label}, ${item.status}, ${section.name}${section.deck ? `, ${section.deck}` : ''}${suggested ? ', recommended' : ''}`}
                                  aria-pressed={active}
                                  aria-describedby={active ? detailId : undefined}
                                  title={item.label}
                                  onClick={() =>
                                    setSelected({ sectionId: section.id, seatLabel: item.label })
                                  }
                                >
                                  <span className="seat-label">{item.label}</span>
                                  {active && (
                                    <Check
                                      className="seat-selection-check"
                                      size={10}
                                      aria-hidden="true"
                                    />
                                  )}
                                </button>
                              );
                            })}
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            ))}
          </div>
        </div>
        <div className="seat-inspector" id={detailId} aria-live="polite" aria-atomic="true">
          <div className="seat-inspector-main">
            <span className="presentation-eyebrow">
              {recommended ? 'Recommended seat' : 'Seat details'}
            </span>
            <strong className="seat-number">{current.seat.label}</strong>
            <span className="seat-location">
              {current.section.name}
              {current.section.deck ? ` · ${current.section.deck}` : ''}
            </span>
          </div>
          <div className="seat-inspector-facts">
            <span className={`seat-status is-${current.seat.status}`}>
              {current.seat.status === 'unknown'
                ? 'Availability unknown'
                : current.seat.status === 'available'
                  ? 'Available in source'
                  : 'Unavailable in source'}
            </span>
            {current.seat.price && <strong className="seat-price">{current.seat.price}</strong>}
            {current.seat.note && <p>{current.seat.note}</p>}
          </div>
          <p className="presentation-footnote">Inspect a seat for details. Nothing is reserved.</p>
        </div>
      </div>
    </>
  );
}
