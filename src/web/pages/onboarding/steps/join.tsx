import { useRef, useState } from 'react';
import { communityLinks } from '../../../../shared/onboarding';
import { ArrowUpRight } from '../../../components/icons';
import { Rise } from '../../../components/motion';
import { ServiceLogo } from '../../../components/service-logo';
import { Checkbox, Input } from '../../../components/ui';
import { api, errorMessage } from '../../../lib/api';
import { captureAnalytics } from '../../../lib/analytics';
import type { StepProps } from '..';
import { Bubble, Footer, Messages, useReveal } from '../motion';

const privacyUrl = 'https://nod-docs.pages.dev/trust/privacy/#email-updates';
const consentRequired = 'Tick the box to sign up with this email.';
const emailInvalid = 'Enter a valid email address.';

export function Join({ arrived, onNext, onBack, nextLabel, updates }: StepProps) {
  const { revealed, typing, done, skip } = useReveal([{ typing: 450 }, { wait: 200 }], {
    enabled: arrived === 'forward',
  });
  const field = useRef<HTMLInputElement>(null);
  const [email, setEmail] = useState('');
  const [agreed, setAgreed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState('');
  const failed = Boolean(notice) && notice !== consentRequired && notice !== emailInvalid;

  async function finish() {
    const address = email.trim();
    if (!updates || !address || failed) return onNext();
    if (field.current && !field.current.checkValidity()) return setNotice(emailInvalid);
    if (!agreed) return setNotice(consentRequired);
    setSaving(true);
    try {
      await api('/api/onboarding/updates', {
        method: 'POST',
        body: JSON.stringify({ email: address }),
      });
      captureAnalytics('onboarding_updates_subscribed');
      onNext();
    } catch (cause) {
      setNotice(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  }

  function edited() {
    setNotice('');
  }

  return (
    <section className="ob-step ob-join" data-analytics-public onClick={done ? undefined : skip}>
      <Messages
        revealed={revealed}
        typing={typing}
        items={[
          <Bubble>
            {updates ? (
              <>
                <strong>Want occasional updates on Nod?</strong> Leave your email below, or join the
                community.
              </>
            ) : (
              <>
                <strong>Want to stay up to date on Nod?</strong> Join the community.
              </>
            )}
          </Bubble>,
        ]}
      />
      <Rise show={done} className="ob-join-body">
        {updates && (
          <div className="ob-join-updates">
            <label className="sr-only" htmlFor="ob-join-email">
              Email
            </label>
            <Input
              ref={field}
              id="ob-join-email"
              type="email"
              autoComplete="email"
              placeholder="you@example.com"
              value={email}
              data-analytics-private
              aria-invalid={notice === emailInvalid || undefined}
              aria-describedby={notice === emailInvalid ? 'ob-join-note' : undefined}
              onChange={(event) => {
                setEmail(event.target.value);
                edited();
              }}
            />
            <label className="ob-join-consent">
              <Checkbox
                checked={agreed}
                aria-invalid={notice === consentRequired || undefined}
                aria-describedby={notice === consentRequired ? 'ob-join-note' : undefined}
                onChange={(event) => {
                  setAgreed(event.target.checked);
                  edited();
                }}
              />
              <span>
                I agree to get occasional emails about Nod and to the{' '}
                <a href={privacyUrl} target="_blank" rel="noreferrer">
                  privacy policy
                </a>
                . Unsubscribe anytime.
              </span>
            </label>
            {notice && (
              <p className="ob-join-note" id="ob-join-note" role="alert">
                {notice}
              </p>
            )}
          </div>
        )}
        <div className="ob-join-links">
          <a
            className="ob-join-link"
            href={communityLinks.discord}
            target="_blank"
            rel="noreferrer"
            onClick={() => captureAnalytics('onboarding_community_opened', { channel: 'discord' })}
          >
            <span className="ob-join-logo">
              <ServiceLogo slug="discord" logoUrl="/logos/discord.svg" size={20} />
            </span>
            <span>Chat with the Nod team and community on Discord</span>
            <ArrowUpRight size={16} aria-hidden="true" />
          </a>
          <a
            className="ob-join-link"
            href={communityLinks.forum}
            target="_blank"
            rel="noreferrer"
            onClick={() => captureAnalytics('onboarding_community_opened', { channel: 'forum' })}
          >
            <span className="ob-join-logo">
              <ServiceLogo slug="n8n" logoUrl="/logos/n8n.svg" size={24} />
            </span>
            <span>Share ideas and help shape Nod on the forum</span>
            <ArrowUpRight size={16} aria-hidden="true" />
          </a>
        </div>
      </Rise>
      <Footer
        onBack={onBack}
        onNext={() => void finish()}
        nextLabel={nextLabel ?? 'Continue'}
        busy={saving}
      />
    </section>
  );
}
