import { useState } from 'react';
import { communityLinks } from '../../../../shared/onboarding';
import { At } from '../../../components/icons';
import { Rise } from '../../../components/motion';
import { ServiceLogo } from '../../../components/service-logo';
import { Button, Input } from '../../../components/ui';
import { api, errorMessage } from '../../../lib/api';
import { captureAnalytics } from '../../../lib/analytics';
import type { StepProps } from '..';
import { Bubble, Footer, Messages, useReveal } from '../motion';

const privacyUrl = 'https://nod-docs.pages.dev/trust/privacy/#email-updates';

export function Join({ arrived, onNext, onBack, nextLabel, updates }: StepProps) {
  const { revealed, typing, done, skip } = useReveal([{ typing: 450 }, { wait: 200 }], {
    enabled: arrived === 'forward',
  });
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [error, setError] = useState('');

  async function subscribe() {
    const address = email.trim();
    if (!address || status !== 'idle') return;
    setStatus('saving');
    setError('');
    try {
      await api('/api/onboarding/updates', {
        method: 'POST',
        body: JSON.stringify({ email: address }),
      });
      captureAnalytics('nod_onboarding_updates_subscribed');
      setStatus('saved');
    } catch (cause) {
      setError(errorMessage(cause));
      setStatus('idle');
    }
  }

  return (
    <section className="ob-step ob-join" data-analytics-public onClick={done ? undefined : skip}>
      <Messages
        revealed={revealed}
        typing={typing}
        items={[
          <Bubble>
            <strong>Want to stay up to date on Nod?</strong> Join the community, share your ideas,
            or get occasional updates.
          </Bubble>,
        ]}
      />
      <Rise show={done} className="ob-join-group">
        <div className="ob-join-row">
          <ServiceLogo slug="discord" logoUrl="/logos/discord.svg" size={24} />
          <span className="ob-join-title">Chat with the Nod team and community</span>
          <Button variant="outline" asChild>
            <a
              href={communityLinks.discord}
              target="_blank"
              rel="noreferrer"
              onClick={() =>
                captureAnalytics('nod_onboarding_community_opened', { channel: 'discord' })
              }
            >
              Join Discord
            </a>
          </Button>
        </div>
        <div className="ob-join-divider" aria-hidden="true" />
        <div className="ob-join-row">
          <ServiceLogo slug="n8n" logoUrl="/logos/n8n.svg" size={24} />
          <span className="ob-join-title">Share ideas and help shape Nod</span>
          <Button variant="outline" asChild>
            <a
              href={communityLinks.forum}
              target="_blank"
              rel="noreferrer"
              onClick={() =>
                captureAnalytics('nod_onboarding_community_opened', { channel: 'forum' })
              }
            >
              Open forum
            </a>
          </Button>
        </div>
        {updates && (
          <>
            <div className="ob-join-divider" aria-hidden="true" />
            <div className="ob-join-updates">
              <div className="ob-join-row">
                <At size={24} aria-hidden="true" />
                <label className="ob-join-title" htmlFor="ob-join-email">
                  Be the first to hear what’s new
                </label>
              </div>
              <form
                className="ob-join-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  void subscribe();
                }}
              >
                <Input
                  id="ob-join-email"
                  type="email"
                  autoComplete="email"
                  placeholder="you@example.com"
                  value={email}
                  data-analytics-private
                  onChange={(event) => {
                    setEmail(event.target.value);
                    if (status === 'saved') setStatus('idle');
                  }}
                />
                <Button
                  type="submit"
                  variant="outline"
                  disabled={!email.trim() || status !== 'idle'}
                  aria-busy={status === 'saving'}
                >
                  Subscribe
                </Button>
              </form>
              <p className="ob-join-note" role={error ? 'alert' : undefined}>
                {error ||
                  (status === 'saved' ? (
                    'Thanks! We’ll be in touch.'
                  ) : (
                    <>
                      Occasional emails about Nod. Unsubscribe anytime.{' '}
                      <a href={privacyUrl} target="_blank" rel="noreferrer">
                        Privacy policy
                      </a>
                    </>
                  ))}
              </p>
            </div>
          </>
        )}
      </Rise>
      <Footer
        onBack={onBack}
        onNext={onNext}
        nextLabel={nextLabel ?? 'Continue'}
        busy={status === 'saving'}
      />
    </section>
  );
}
