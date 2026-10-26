import { useEffect, useState } from 'react';
import Markdown from 'react-markdown';
import type { PrivacyNoticeResponse } from '../../shared/privacy';
import { BrandMark } from '../components/brand';
import { Button, Loading, Notice } from '../components/ui';

export function Privacy() {
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const previousTitle = document.title;
    document.title = 'Privacy · Nod';
    return () => {
      document.title = previousTitle;
    };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setFailed(false);
    void fetch('/api/privacy', {
      signal: controller.signal,
      credentials: 'omit',
      cache: 'no-store',
    })
      .then(async (response) => {
        if (!response.ok) throw new Error();
        const result = (await response.json()) as PrivacyNoticeResponse;
        if (!result || (result.content !== null && typeof result.content !== 'string'))
          throw new Error();
        if (!controller.signal.aborted) setContent(result.content);
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [attempt]);
  return (
    <main className="privacy-page">
      <header className="privacy-header">
        <a className="privacy-brand" href="/" aria-label="Nod home">
          <BrandMark />
          <span>Nod</span>
        </a>
        <a className="privacy-back" href="/">
          Back to Nod
        </a>
      </header>
      <article className="privacy-document">
        <h1>Privacy</h1>
        {loading ? (
          <Loading label="Loading privacy notice…" />
        ) : failed ? (
          <div className="privacy-unavailable">
            <Notice>The privacy notice could not be loaded.</Notice>
            <Button variant="outline" onClick={() => setAttempt((value) => value + 1)}>
              Try again
            </Button>
          </div>
        ) : content ? (
          <div className="privacy-content">
            <Markdown
              skipHtml
              allowedElements={[
                'h2',
                'h3',
                'h4',
                'p',
                'a',
                'strong',
                'em',
                'ul',
                'ol',
                'li',
                'blockquote',
                'br',
                'code',
              ]}
              unwrapDisallowed
              components={{
                a: ({ href, children }) => (
                  <a href={href} rel="noopener noreferrer">
                    {children}
                  </a>
                ),
              }}
            >
              {content}
            </Markdown>
          </div>
        ) : (
          <p className="privacy-empty">A privacy notice has not been published here yet.</p>
        )}
      </article>
    </main>
  );
}
