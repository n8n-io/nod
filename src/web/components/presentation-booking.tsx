import { useState } from 'react';
import type { Presentation } from '../../shared/presentation';
import { useArtifactDrawer } from './artifact-context';
import { ArrowUpRight, ExternalLink, Maximize2 } from './icons';

type BookingVisual = Extract<Presentation, { type: 'booking' }>;
type Venue = Omit<
  BookingVisual,
  'version' | 'type' | 'title' | 'caption' | 'sources' | 'asOf' | 'alternatives'
>;

function VenuePhotos({ photos, name }: { photos: NonNullable<Venue['photos']>; name: string }) {
  const drawer = useArtifactDrawer();
  const [active, setActive] = useState(0);
  const [failed, setFailed] = useState<ReadonlySet<string>>(new Set());
  const photo = photos[active]!;
  return (
    <div className="booking-photos">
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
          <span>
            <Maximize2 size={14} aria-hidden="true" /> View photo
          </span>
        </button>
      )}
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
              <span>{index + 1}</span>
              <span>{item.alt}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function VenueCard({ venue }: { venue: Venue }) {
  const labels = {
    option: 'Option',
    pending: 'Pending confirmation',
    confirmed: 'Confirmed',
    cancelled: 'Cancelled',
  };
  return (
    <section className="booking-summary" aria-label={venue.name}>
      {venue.photos && venue.photos.length > 0 && (
        <VenuePhotos key={JSON.stringify(venue.photos)} photos={venue.photos} name={venue.name} />
      )}
      <div className="booking-content">
        <div className="booking-name">
          <h4>{venue.name}</h4>
          <span className={`booking-status is-${venue.status}`}>{labels[venue.status]}</span>
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
            {venue.rating.summary && <p>{venue.rating.summary}</p>}
          </div>
        )}
        <dl>
          {venue.facts.map((fact, index) => (
            <div key={index}>
              <dt>{fact.label}</dt>
              <dd>{fact.value}</dd>
            </div>
          ))}
        </dl>
        {venue.notes && venue.notes.length > 0 && (
          <div className="booking-notes">
            <h5>Good to know</h5>
            <ul>
              {venue.notes.map((note, index) => (
                <li key={index}>{note}</li>
              ))}
            </ul>
          </div>
        )}
        {venue.url && (
          <a
            className="booking-link"
            href={venue.url}
            target="_blank"
            rel="noopener noreferrer"
            referrerPolicy="no-referrer"
          >
            {venue.status === 'option' ? 'View option' : 'View booking'}
            <ArrowUpRight size={16} aria-hidden="true" />
          </a>
        )}
      </div>
    </section>
  );
}

export function Booking({ visual }: { visual: BookingVisual }) {
  return (
    <div className={`booking-venues${visual.alternatives?.length ? ' is-comparison' : ''}`}>
      {[visual, ...(visual.alternatives ?? [])].map((venue, index) => (
        <VenueCard key={index} venue={venue} />
      ))}
    </div>
  );
}
