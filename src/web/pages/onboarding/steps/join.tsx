import { useRef, useState } from 'react';
import { regexes } from 'zod';
import { communityLinks } from '../../../../shared/onboarding';
import { ArrowUpRight } from '../../../components/icons';
import { ServiceLogo } from '../../../components/service-logo';
import { Input } from '../../../components/ui';
import { api, errorMessage } from '../../../lib/api';
import { analyticsForCurrentSession, captureAnalytics } from '../../../lib/analytics';
import type { StepProps } from '..';
import { Bubble, Footer, Messages } from '../motion';

const privacyUrl = 'https://nod.n8n.io/docs/trust/privacy/#research-invitations';

export function Join({ onNext, onBack, nextLabel, researchContact, usageShared }: StepProps) {
  const [email, setEmail] = useState('');
  const [consent, setConsent] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<{
    field: 'email' | 'consent' | 'server';
    message: string;
  } | null>(null);
  const submitting = useRef(false);
  const canSubscribe = Boolean(researchContact && usageShared);

  async function advance(retry = false) {
    if (submitting.current) return;
    const address = email.trim();
    if (!canSubscribe || !address || (error?.field === 'server' && !retry)) return onNext();
    if (address.length > 254 || !regexes.email.test(address)) {
      setError({ field: 'email', message: 'Enter a valid email address.' });
      return;
    }
    if (!consent) {
      setError({ field: 'consent', message: 'Tick the box to receive Nod research invitations.' });
      return;
    }
    submitting.current = true;
    setSaving(true);
    setError(null);
    const capture = analyticsForCurrentSession();
    try {
      await api('/api/onboarding/research-contact', {
        method: 'POST',
        body: JSON.stringify({ email: address, consent: true }),
      });
      capture('onboarding_research_contact_submitted');
      onNext();
    } catch (cause) {
      setError({ field: 'server', message: errorMessage(cause) });
    } finally {
      submitting.current = false;
      setSaving(false);
    }
  }

  return (
    <section className="ob-step ob-join">
      <Messages
        className="ob-join-intro"
        items={[
          <Bubble>
            {canSubscribe ? (
              <>
                <strong>Help shape Nod.</strong> Leave your email below for occasional invitations
                to participate in Nod research.
              </>
            ) : (
              <>Join the Nod community on Discord or the forum.</>
            )}
          </Bubble>,
        ]}
      />
      {canSubscribe && (
        <div className="ob-join-card" data-analytics-private>
          <form
            className="ob-join-form"
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              void advance();
            }}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' || !(event.target instanceof HTMLInputElement)) return;
              event.preventDefault();
              void advance();
            }}
          >
            <label className="sr-only" htmlFor="ob-join-email">
              Email address
            </label>
            <Input
              id="ob-join-email"
              type="email"
              autoComplete="email"
              placeholder="you@example.com"
              value={email}
              disabled={saving}
              aria-invalid={error?.field === 'email'}
              aria-describedby={error?.field === 'email' ? 'ob-join-error' : undefined}
              onChange={(event) => {
                setEmail(event.target.value);
                setError(null);
              }}
            />
            <label className="ob-join-consent">
              <input
                type="checkbox"
                checked={consent}
                disabled={saving}
                aria-invalid={error?.field === 'consent'}
                aria-describedby={error?.field === 'consent' ? 'ob-join-error' : undefined}
                onChange={(event) => {
                  setConsent(event.target.checked);
                  setError(null);
                }}
              />
              <span>
                I agree to receive occasional invitations to Nod research by email. I have read the{' '}
                <a href={privacyUrl} target="_blank" rel="noreferrer">
                  privacy policy
                </a>
                .
              </span>
            </label>
            {error && (
              <p id="ob-join-error" className="ob-join-feedback ob-join-error" role="alert">
                {error.message}
                {error.field === 'server' && (
                  <button
                    type="button"
                    className="ob-join-retry"
                    onClick={() => void advance(true)}
                  >
                    Try again
                  </button>
                )}
              </p>
            )}
          </form>
        </div>
      )}
      <div className="ob-join-community" data-analytics-public>
        <div className="ob-join-links">
          <a
            href={communityLinks.discord}
            target="_blank"
            rel="noreferrer"
            onClick={() => captureAnalytics('onboarding_community_opened', { channel: 'discord' })}
          >
            <ServiceLogo slug="discord" logoUrl="/logos/discord.svg" size={18} />
            <span>Chat with the Nod team and community on Discord</span>
            <ArrowUpRight size={16} aria-hidden="true" />
          </a>
          <a
            href={communityLinks.forum}
            target="_blank"
            rel="noreferrer"
            onClick={() => captureAnalytics('onboarding_community_opened', { channel: 'forum' })}
          >
            <ServiceLogo slug="n8n" logoUrl="/logos/n8n.svg" size={18} />
            <span>Share ideas and help shape Nod on the forum</span>
            <ArrowUpRight size={16} aria-hidden="true" />
          </a>
        </div>
      </div>
      <Footer
        onBack={onBack}
        onNext={() => void advance()}
        nextLabel={error?.field === 'server' ? 'Continue to chat' : (nextLabel ?? 'Continue')}
        busy={saving}
      />
    </section>
  );
}
