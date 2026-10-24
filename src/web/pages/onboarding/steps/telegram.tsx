import { useEffect, useRef, useState } from 'react';
import { Send } from '../../../components/icons';
import type { StepProps } from '..';
import { Rise } from '../../../components/motion';
import { TelegramSetup } from '../../../components/telegram-setup';
import { Button } from '../../../components/ui';
import { telegramState, useChannelSettings } from '../../../hooks/use-channel-settings';
import { channelSetupBody } from '../../../lib/secondary-pages';
import { Bubble, Footer, Messages, useReveal } from '../motion';

const sequence = [{ typing: 450 }, { wait: 300, typing: 550 }, { wait: 200 }, { wait: 300 }];

export function Telegram({ arrived, onNext, onBack, onSkip, nextLabel }: StepProps) {
  const { revealed, typing, done, skip } = useReveal(sequence, {
    enabled: arrived === 'forward',
  });
  const {
    data,
    settings,
    telegram,
    error,
    setError,
    loadError,
    loading,
    busy,
    pairingUrl,
    load,
    save,
    telegramAction,
  } = useChannelSettings({ watchTelegram: true });
  const state = telegramState(telegram);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [manual, setManual] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const issued = useRef(false);

  useEffect(() => {
    if (!settings?.ready || issued.current || !state.ready || state.paired || pairingUrl) return;
    if (state.candidate && state.waiting) return;
    issued.current = true;
    void telegramAction('pairing');
  }, [settings, state.ready, state.paired, state.candidate, state.waiting, pairingUrl]);

  useEffect(() => {
    if (state.saved) setFields({});
  }, [state.saved]);

  useEffect(() => {
    if (arrived !== 'forward' || !confirmed || !state.paired || busy || error || loadError) return;
    setConfirmed(false);
    onNext();
  }, [arrived, confirmed, state.paired, busy, error, loadError, onNext]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy || !settings?.ready) return;
    issued.current = true;
    const result = await save('telegram', channelSetupBody('telegram', fields, false));
    if (result.ok || result.channel?.enabled) setFields({});
  }

  async function action(kind: 'pairing' | 'confirm' | 'user', body: object = {}) {
    if (busy || !settings?.ready) return;
    if (!(await telegramAction(kind, body))) return;
    setConfirmed(kind === 'confirm' || kind === 'user');
    setManual(false);
    setFields({});
  }

  return (
    <section className="ob-step ob-telegram" onClick={done ? undefined : skip}>
      <div data-analytics-public>
        <Messages
          revealed={revealed}
          typing={typing}
          items={[
            <Bubble>Want me in your pocket?</Bubble>,
            <Bubble>
              Connect Telegram to message me from your phone. I’ll walk you through it.
            </Bubble>,
          ]}
        />
      </div>
      <Rise show={revealed >= 3 && Boolean(settings || loadError)} className="ob-tg-card">
        <div className="ob-tg-heading" data-analytics-public>
          <span className="ob-tg-logo">
            <Send size={18} aria-hidden="true" />
          </span>
          <p>Telegram</p>
        </div>
        <TelegramSetup
          setup={telegram}
          pairingUrl={pairingUrl}
          manual={manual}
          fields={fields}
          busy={busy}
          error={error || loadError || data?.error || ''}
          unavailable={!settings?.ready}
          onField={(name, value) => {
            setFields((current) => ({ ...current, [name]: value }));
            setError('');
          }}
          onVerify={(event) => void submit(event)}
          onConfirm={() => void action('confirm')}
          onNewLink={() => void action('pairing')}
          onManual={(value) => {
            setError('');
            setManual(value);
          }}
          onSaveId={(event) => {
            event.preventDefault();
            void action('user', { allowedUserId: fields.allowedUserId?.trim() });
          }}
        />
        {loadError && (
          <Button
            variant="outline"
            size="sm"
            disabled={loading || busy}
            onClick={() => void load()}
          >
            {loading ? 'Retrying…' : 'Retry loading'}
          </Button>
        )}
      </Rise>
      <Footer
        show={revealed >= 4}
        onBack={onBack}
        onSkip={
          state.paired
            ? undefined
            : () => {
                onSkip?.();
                onNext();
              }
        }
        onNext={onNext}
        nextLabel={nextLabel}
        nextDisabled={!state.paired}
      />
    </section>
  );
}
