import { useEffect, useState } from 'react';
import { Download, ExternalLink, MapPin, UserRound } from './icons';
import { contactCards, sharedLocation, type SharedLocation } from '../../shared/channel-content';
import { textPreviewBytes } from '../lib/attachment-kind';
import { apiBytes } from '../lib/api';
import { ownedArtifactUrl } from '../lib/attachment-url';
import type { ImagePreview } from './attachment-images';
import { Button } from './ui';

export function SharedMessageCard({
  item,
  selected = false,
}: {
  item: ImagePreview;
  selected?: boolean;
}) {
  const locationFile = item.source === 'location' || item.name === 'location.json';
  const [content, setContent] = useState<
    { location: SharedLocation } | { contacts: ReturnType<typeof contactCards> }
  >();
  const [failed, setFailed] = useState(false);
  const [map, setMap] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    const limit = locationFile ? 4096 : textPreviewBytes;
    if (!ownedArtifactUrl(item.url) || item.size > limit) {
      setFailed(true);
      return;
    }
    void apiBytes(item.url, limit, { signal: controller.signal, redirect: 'error' })
      .then((bytes) => {
        if (controller.signal.aborted) return;
        const text = new TextDecoder().decode(bytes);
        if (locationFile) setContent({ location: sharedLocation.parse(JSON.parse(text)) });
        else {
          const contacts = contactCards(text);
          if (!contacts.length) throw new Error('Contact preview unavailable.');
          setContent({ contacts });
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      });
    return () => controller.abort();
  }, [item.url, item.size, locationFile]);
  if (!ownedArtifactUrl(item.url)) return null;
  const location = content && 'location' in content ? content.location : undefined;
  const lat = location?.latitude ?? 0;
  const lon = location?.longitude ?? 0;
  const centerLat = Math.max(-85, Math.min(85, lat));
  const query = new URLSearchParams({
    bbox: [
      Math.max(-180, lon - 0.008),
      Math.max(-85, centerLat - 0.005),
      Math.min(180, lon + 0.008),
      Math.min(85, centerLat + 0.005),
    ].join(','),
    layer: 'mapnik',
    marker: `${lat},${lon}`,
  });
  const mapUrl = `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=16/${lat}/${lon}`;
  return (
    <div className="shared-message-card" aria-current={selected || undefined}>
      {location ? (
        <>
          {map ? (
            <iframe
              title="Shared location map"
              src={`https://www.openstreetmap.org/export/embed.html?${query}`}
              sandbox="allow-scripts allow-same-origin"
              referrerPolicy="no-referrer"
              loading="lazy"
            />
          ) : (
            <button type="button" className="shared-location-preview" onClick={() => setMap(true)}>
              <MapPin size={32} aria-hidden="true" />
              <span>View map</span>
              <small>Load from OpenStreetMap</small>
            </button>
          )}
          <div className="shared-location-details">
            <strong>{location.name || 'Shared location'}</strong>
            {location.address && <span>{location.address}</span>}
            <span>
              {lat.toFixed(5)}, {lon.toFixed(5)}
            </span>
            <a href={mapUrl} target="_blank" rel="noopener noreferrer">
              Open in OpenStreetMap <ExternalLink size={12} aria-hidden="true" />
            </a>
          </div>
        </>
      ) : content && 'contacts' in content ? (
        content.contacts.slice(0, 3).map((contact, index) => (
          <div className="shared-contact" key={index}>
            <span className="shared-contact-avatar" aria-hidden="true">
              <UserRound size={22} />
            </span>
            <div>
              <strong>{contact.name}</strong>
              {contact.organization && <span>{contact.organization}</span>}
              {contact.title && <span>{contact.title}</span>}
              {contact.phones.map((phone, index) => (
                <span key={index}>{phone}</span>
              ))}
              {contact.emails.map((email, index) => (
                <span key={index}>{email}</span>
              ))}
              {contact.addresses.map((address, index) => (
                <span key={index}>{address}</span>
              ))}
              {contact.urls.map((url, index) => (
                <span key={index}>{url}</span>
              ))}
            </div>
          </div>
        ))
      ) : (
        <p role="status">{failed ? 'Preview unavailable' : 'Loading…'}</p>
      )}
      {content && 'contacts' in content && content.contacts.length > 3 && (
        <p>{content.contacts.length - 3} more contacts in the file</p>
      )}
      <Button variant="ghost" size="sm" className="shared-message-download" asChild>
        <a href={item.url} download={item.name}>
          <Download size={14} aria-hidden="true" />
          {locationFile ? 'Location file' : 'Save contact'}
        </a>
      </Button>
    </div>
  );
}
