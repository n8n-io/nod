import { useId, useState, type ReactNode } from 'react';
import type { Presentation } from '../../shared/presentation';
import { useArtifactDrawer } from './artifact-context';
import { ArrowUpRight, CalendarClock, ChevronDown, ExternalLink, Maximize2 } from './icons';

const priceLabel = /price|fare|cost|total|cena|preis|prix|precio|prezzo/i;

function hostOf(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

type BookingVisual = Extract<Presentation, { type: 'booking' }>;
type Venue = Omit<
  BookingVisual,
  'version' | 'type' | 'title' | 'caption' | 'sources' | 'asOf' | 'alternatives'
>;

function VenuePhotos({
  photos,
  name,
  action,
}: {
  photos: NonNullable<Venue['photos']>;
  name: string;
  action?: ReactNode;
}) {
  const drawer = useArtifactDrawer();
  const [active, setActive] = useState(0);
  const [failed, setFailed] = useState<ReadonlySet<string>>(new Set());
  const photo = photos[active]!;
  return (
    <div className="booking-photos">
      <div className="booking-photo-frame">
        {failed.has(photo.artifactId) ? (
          <div className="booking-photo-unavailable" role="status">
            <span>{photo.alt}</span>
            <small>This photo is unavailable.</small>
          </div>
        ) : (
          <button
            className="booking-photo"
            type="button"
            aria-label={`Open photo of ${name}: ${photo.alt}`}
            onClick={(event) =>
              drawer.open(photo.artifactId, {
                element: event.currentTarget,
                keyboard: event.detail === 0,
              })
            }
          >
            <img
              src={`/api/artifacts/${photo.artifactId}`}
              alt={photo.alt}
              loading="lazy"
              onError={() => setFailed((current) => new Set([...current, photo.artifactId]))}
            />
            {!action && (
              <span aria-hidden="true">
                <Maximize2 size={14} />
              </span>
            )}
          </button>
        )}
        {action}
      </div>
      {photos.length > 1 && (
        <div className="booking-photo-picker" role="group" aria-label={`Photos of ${name}`}>
          {photos.map((item, index) => (
            <button
              type="button"
              key={`${item.artifactId}-${index}`}
              aria-label={`Photo ${index + 1}: ${item.alt}`}
              aria-pressed={active === index}
              onClick={() => setActive(index)}
            >
              {failed.has(item.artifactId) ? (
                <span>{index + 1}</span>
              ) : (
                <img
                  src={`/api/artifacts/${item.artifactId}`}
                  alt=""
                  loading="lazy"
                  onError={() => setFailed((current) => new Set([...current, item.artifactId]))}
                />
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function VenueCard({ venue, action }: { venue: Venue; action?: ReactNode }) {
  const detailsId = useId();
  const [open, setOpen] = useState(false);
  const hasPhotos = Boolean(venue.photos?.length);
  const first = venue.facts.findIndex((fact) => priceLabel.test(fact.label));
  const price = first > 1 ? first : -1;
  const summary = venue.facts.filter((_, index) => index < 2 || index === price);
  const rest = venue.facts.filter((_, index) => index >= 2 && index !== price);
  const more = rest.length > 0 || Boolean(venue.notes?.length) || Boolean(venue.rating);
  const host = venue.url ? hostOf(venue.url) : null;
  const labels = {
    option: 'Not booked',
    pending: 'Pending confirmation',
    confirmed: 'Confirmed',
    cancelled: 'Cancelled',
  };
  return (
    <section className="booking-summary" aria-label={venue.name}>
      <div className="booking-content">
        <div className="booking-name">
          <div className="booking-title">
            {!hasPhotos && (
              <span className="booking-symbol">
                <CalendarClock size={16} aria-hidden="true" />
                {!venue.url && action}
              </span>
            )}
            <h4>{venue.name}</h4>
          </div>
          <span className={`booking-status is-${venue.status}`}>{labels[venue.status]}</span>
        </div>
        <div className="booking-overview">
          <dl className="booking-facts">
            {summary.map((fact, index) => (
              <div key={index}>
                <dt>{fact.label}</dt>
                <dd>{fact.value}</dd>
              </div>
            ))}
          </dl>
          {venue.photos && venue.photos.length > 0 && (
            <VenuePhotos
              key={JSON.stringify(venue.photos)}
              photos={venue.photos}
              name={venue.name}
              action={!venue.url ? action : undefined}
            />
          )}
        </div>
        {more && (
          <div className="booking-details" id={detailsId} hidden={!open}>
            {rest.length > 0 && (
              <dl className="booking-facts">
                {rest.map((fact, index) => (
                  <div key={index}>
                    <dt>{fact.label}</dt>
                    <dd>{fact.value}</dd>
                  </div>
                ))}
              </dl>
            )}
            {venue.rating && <Rating rating={venue.rating} />}
            {venue.notes && venue.notes.length > 0 && (
              <div className="booking-notes">
                <ul aria-label="Booking notes">
                  {venue.notes.map((note, index) => (
                    <li key={index}>{note}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
        {(venue.url || more) && (
          <div className="booking-actions">
            <div className="booking-buttons">
              {venue.url && (
                <a
                  className="booking-check"
                  href={venue.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  referrerPolicy="no-referrer"
                >
                  {venue.status === 'option'
                    ? host
                      ? `Check on ${host}`
                      : 'Check on the site'
                    : 'View booking'}
                  <ArrowUpRight size={16} aria-hidden="true" />
                </a>
              )}
              {more && (
                <button
                  type="button"
                  className="booking-more"
                  aria-expanded={open}
                  aria-controls={detailsId}
                  onClick={() => setOpen(!open)}
                >
                  {open ? 'Hide details' : 'See details'}
                  <ChevronDown size={14} aria-hidden="true" />
                </button>
              )}
            </div>
            {venue.url && action}
          </div>
        )}
      </div>
    </section>
  );
}

function Rating({ rating }: { rating: NonNullable<Venue['rating']> }) {
  return (
    <div className="booking-review">
      <a href={rating.url} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">
        <span className="booking-rating">
          <strong>{rating.value}</strong>
          <span>/{rating.scale}</span>
        </span>
        <span className="booking-rating-source">
          <strong>{rating.sourceLabel}</strong>
          {rating.count !== undefined && (
            <span>
              {rating.count.toLocaleString()} {rating.count === 1 ? 'review' : 'reviews'}
            </span>
          )}
        </span>
        <ExternalLink size={14} aria-hidden="true" />
      </a>
      {rating.summary && <p className="booking-review-summary">{rating.summary}</p>}
    </div>
  );
}

export function Booking({ visual, action }: { visual: BookingVisual; action?: ReactNode }) {
  return (
    <div className={`booking-venues${visual.alternatives?.length ? ' is-comparison' : ''}`}>
      {[visual, ...(visual.alternatives ?? [])].map((venue, index) => (
        <VenueCard key={index} venue={venue} action={index === 0 ? action : undefined} />
      ))}
    </div>
  );
}
