import { useState, type ReactNode } from 'react';
import type { Presentation } from '../../shared/presentation';
import { useArtifactDrawer } from './artifact-context';
import { ArrowUpRight, CalendarClock, ExternalLink, Maximize2 } from './icons';

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
  const hasPhotos = Boolean(venue.photos?.length);
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
            {!hasPhotos && !venue.url && (
              <span className="booking-symbol">
                <CalendarClock size={16} aria-hidden="true" />
                {action}
              </span>
            )}
            <h4>{venue.name}</h4>
          </div>
          <span className={`booking-status is-${venue.status}`}>{labels[venue.status]}</span>
        </div>
        <div className="booking-overview">
          <dl className="booking-facts">
            {venue.facts.map((fact, index) => (
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
        {venue.rating && (
          <div className="booking-review">
            <a
              href={venue.rating.url}
              target="_blank"
              rel="noopener noreferrer"
              referrerPolicy="no-referrer"
            >
              <span className="booking-rating">
                <strong>{venue.rating.value}</strong>
                <span>/{venue.rating.scale}</span>
              </span>
              <span className="booking-rating-source">
                <strong>{venue.rating.sourceLabel}</strong>
                {venue.rating.count !== undefined && (
                  <span>
                    {venue.rating.count.toLocaleString()}{' '}
                    {venue.rating.count === 1 ? 'review' : 'reviews'}
                  </span>
                )}
              </span>
              <ExternalLink size={14} aria-hidden="true" />
            </a>
            {venue.rating.summary && (
              <p className="booking-review-summary">{venue.rating.summary}</p>
            )}
          </div>
        )}
        {venue.notes && venue.notes.length > 0 && (
          <div className="booking-notes">
            <ul aria-label="Booking notes">
              {venue.notes.map((note, index) => (
                <li key={index}>{note}</li>
              ))}
            </ul>
          </div>
        )}
        {venue.url && (
          <div className="booking-actions">
            <a
              className="booking-link"
              href={venue.url}
              target="_blank"
              rel="noopener noreferrer"
              referrerPolicy="no-referrer"
            >
              {venue.status === 'option' ? 'View details' : 'View booking'}
              <ArrowUpRight size={16} aria-hidden="true" />
            </a>
            {action}
          </div>
        )}
      </div>
    </section>
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
