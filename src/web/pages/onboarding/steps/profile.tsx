import { useState } from 'react';
import type { AnalyticsProfile } from '../../../../shared/analytics-profile';
import { Button, Field } from '../../../components/ui';
import { errorMessage } from '../../../lib/api';
import type { StepProps } from '..';
import { Bubble, Footer, Messages } from '../motion';

const tools = [
  ['chatgpt', 'ChatGPT'],
  ['claude', 'Claude'],
  ['gemini', 'Gemini'],
  ['copilot', 'Copilot'],
  ['n8n', 'n8n'],
  ['coding_agents', 'Coding agents'],
  ['other', 'Other'],
  ['none', 'None yet'],
] as const;

export function Profile({ onNext, onBack, onSkip, profile, usageShared }: StepProps) {
  const [value, setValue] = useState<AnalyticsProfile>(profile?.value ?? {});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  async function save() {
    if (saving) return;
    if (
      !Object.values(value).some((item) => item !== undefined) &&
      !Object.values(profile?.value ?? {}).some((item) => item !== undefined)
    ) {
      onSkip?.();
      onNext();
      return;
    }
    setSaving(true);
    setError('');
    try {
      await profile?.onChange(value);
      onNext();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  }
  return (
    <section className="ob-step ob-profile" data-analytics-private>
      <Messages
        items={[
          <Bubble>Who is Nod useful for?</Bubble>,
          <Bubble>
            These optional answers help the Nod team understand who comes back.
            {usageShared
              ? ' They are shared with your usage data.'
              : ' Usage sharing is off, so they stay on this installation.'}
          </Bubble>,
        ]}
      />
      <div className="ob-profile-fields">
        <Field label="What best describes you?">
          <select
            className="input"
            value={value.role ?? ''}
            disabled={saving}
            onChange={(event) =>
              setValue({
                ...value,
                role: (event.target.value as AnalyticsProfile['role']) || undefined,
              })
            }
          >
            <option value="">Prefer not to say</option>
            <option value="agency_owner">Agency owner</option>
            <option value="business_owner">Business owner</option>
            <option value="employee">Employee</option>
            <option value="individual">Using Nod for myself</option>
            <option value="other">Other</option>
          </select>
        </Field>
        <Field label="How big is your company?">
          <select
            className="input"
            value={value.company_size ?? ''}
            disabled={saving}
            onChange={(event) =>
              setValue({
                ...value,
                company_size: (event.target.value as AnalyticsProfile['company_size']) || undefined,
              })
            }
          >
            <option value="">Prefer not to say</option>
            <option value="solo">Just me</option>
            <option value="2_10">2–10 people</option>
            <option value="11_50">11–50 people</option>
            <option value="51_200">51–200 people</option>
            <option value="201_plus">More than 200 people</option>
          </select>
        </Field>
        <Field label="How do you use AI today?">
          <select
            className="input"
            value={value.ai_experience ?? ''}
            disabled={saving}
            onChange={(event) =>
              setValue({
                ...value,
                ai_experience:
                  (event.target.value as AnalyticsProfile['ai_experience']) || undefined,
              })
            }
          >
            <option value="">Prefer not to say</option>
            <option value="new">I'm new to it</option>
            <option value="occasional">I use it occasionally</option>
            <option value="regular">It's part of my daily work</option>
            <option value="technical">I build with AI tools</option>
          </select>
        </Field>
        <fieldset className="ob-profile-tools" disabled={saving}>
          <legend>Which AI tools do you use?</legend>
          <div>
            {tools.map(([key, label]) => (
              <Button
                key={key}
                variant="outline"
                size="sm"
                aria-pressed={value.ai_tools?.includes(key) ?? false}
                onClick={() => {
                  const selected = value.ai_tools ?? [];
                  const next = selected.includes(key)
                    ? selected.filter((item) => item !== key)
                    : key === 'none'
                      ? [key]
                      : [...selected.filter((item) => item !== 'none'), key];
                  setValue({ ...value, ai_tools: next.length ? next : undefined });
                }}
              >
                {label}
              </Button>
            ))}
          </div>
        </fieldset>
      </div>
      {error && (
        <div className="ob-choices">
          <p role="alert" className="ob-choices-error">
            {error}
          </p>
        </div>
      )}
      <Footer
        onBack={onBack}
        busy={saving}
        onSkip={() => {
          onSkip?.();
          onNext();
        }}
        skipLabel="Not now"
        onNext={() => void save()}
      />
    </section>
  );
}
