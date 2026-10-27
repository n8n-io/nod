import type { ProactiveIssue } from '../../shared/proactivity';
import { Button, Loading, Notice } from '../components/ui';
import { usePageData } from '../hooks/use-page-data';
import { navigate } from '../lib/navigation';
import { safeMessageLink } from '../lib/message-links';
import { formatDateTime, useDateFormat } from '../lib/date-format';
import './prepared.css';

export function PreparedWork({ id }: { id: string }) {
  const { data, error, refresh } = usePageData<ProactiveIssue>(`/api/prepared/${id}`);
  const format = useDateFormat();
  return (
    <div className="content-page secondary-page prepared-work" data-analytics-private>
      <Button variant="ghost" onClick={() => navigate('/')}>
        Back to chat
      </Button>
      {error ? (
        <>
          <Notice>This prepared work is unavailable.</Notice>
          <Button variant="outline" onClick={() => void refresh()}>
            Try again
          </Button>
        </>
      ) : !data ? (
        <Loading />
      ) : (
        <>
          <header className="page-heading prepared-work-heading">
            <h1 className="page-title">{data.title}</h1>
            <p className="prepared-work-time">
              Last updated{' '}
              <time dateTime={data.updatedAt}>{formatDateTime(data.updatedAt, format)}</time>
            </p>
          </header>
          {(data.state === 'resolved' || data.state === 'dismissed') && (
            <Notice kind="info">
              {data.state === 'resolved'
                ? 'This matter is resolved.'
                : 'You dismissed this matter.'}
            </Notice>
          )}
          <section aria-label="Prepared result">
            <div className="prepared-work-draft">{data.draft}</div>
          </section>
          {data.unknowns.length > 0 && (
            <section className="prepared-work-notes">
              <h2>Needs checking</h2>
              <ul>
                {data.unknowns.map((unknown, index) => (
                  <li key={index}>{unknown}</li>
                ))}
              </ul>
            </section>
          )}
          <section className="prepared-work-sources">
            <h2>Sources</h2>
            <ul>
              {data.sources.map((source) => {
                const link = source.url
                  ? safeMessageLink(source.url, window.location.origin)
                  : null;
                return (
                  <li key={`${source.sourceId}:${source.id}`}>
                    {link?.kind === 'external' ? (
                      <a href={link.href} target="_blank" rel="noreferrer">
                        {source.label}
                      </a>
                    ) : (
                      source.label
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        </>
      )}
    </div>
  );
}
