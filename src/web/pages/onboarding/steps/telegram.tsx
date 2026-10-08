import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Check, LoaderCircle, Send } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import type { StepProps } from '..';
import { Button, Input } from '../../../components/ui';
import { telegramState, useChannelSettings } from '../../../hooks/use-channel-settings';
import { channelSetupBody } from '../../../lib/secondary-pages';
import { sessionStore } from '../../../lib/session';
import { Bubble, Footer, Grow, Messages, Rise, useReveal } from '../motion';

const sequence = [{ typing: 450 }, { wait: 300, typing: 550 }, { wait: 200 }, { wait: 300 }];
const botFather = 'https://t.me/BotFather';
const steps = [
  {
    title: 'Create your bot',
    body: 'Scan the code with your phone, send /newbot to BotFather and pick any name.',
  },
  { title: 'Paste the token', body: 'BotFather replies with a token. Paste it here.' },
  {
    title: 'Say hi to your bot',
    body: 'Scan the new code and send /start. That links your phone to me.',
  },
];

function Spinner() {
  return <LoaderCircle className="ob-tg-spinner" size={16} aria-hidden="true" />;
}

function Code({ url, title, loading }: { url: string | null; title: string; loading?: boolean }) {
  return (
    <div className="ob-tg-code">
      {url ? (
        <QRCodeSVG value={url} size={184} marginSize={0} level="M" title={title} />
      ) : (
        <span className="ob-tg-code-empty">{loading && <Spinner />}</span>
      )}
    </div>
  );
}

export function Telegram({ arrived, onNext, onBack }: StepProps) {
  const { revealed, typing } = useReveal(sequence, { enabled: arrived === 'forward' });
  const hosted = useSyncExternalStore(
    sessionStore.subscribe,
    () => sessionStore.getSnapshot().session?.auth.mode === 'google',
  );
  const { settings, telegram, error, setError, loadError, busy, pairingUrl, save, telegramAction } =
    useChannelSettings({ watchTelegram: true });
  const state = telegramState(telegram);
  const [hasToken, setHasToken] = useState(false);
  const [token, setToken] = useState('');
  const [tokenError, setTokenError] = useState('');
  const issued = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  const current = state.paired ? 4 : state.saved ? 3 : hasToken ? 2 : 1;
  const unavailable = settings?.ready === false;
  const handle = telegram?.accountHandle ?? 'your bot';
  const liveUrl = state.waiting ? pairingUrl : null;
  const message = tokenError || error || loadError;
  const view = state.paired ? 'paired' : current === 3 ? 'bot' : 'father';

  useEffect(() => {
    if (!settings || issued.current || !state.ready || state.paired || pairingUrl) return;
    if (state.candidate && state.waiting) return;
    issued.current = true;
    void telegramAction('pairing');
  }, [settings, state.ready, state.paired, state.candidate, state.waiting, pairingUrl]);

  useEffect(() => {
    if (state.saved) setToken('');
  }, [state.saved]);

  useEffect(() => {
    if (current === 2 && hasToken) input.current?.focus();
  }, [current, hasToken]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy || unavailable) return;
    if (!token.trim()) return setTokenError('Paste your bot token first.');
    setTokenError('');
    issued.current = true;
    const result = await save('telegram', channelSetupBody('telegram', { botToken: token }, false));
    if (result.ok || result.channel?.enabled) setToken('');
  }

  function pairing() {
    if (state.needsDelivery)
      return (
        <Button
          variant="outline"
          className="ob-tg-action"
          disabled={busy}
          data-analytics-public
          onClick={() => void telegramAction('pairing')}
        >
          {busy ? 'Connecting…' : 'Try again'}
        </Button>
      );
    if (state.candidate && state.waiting)
      return (
        <div className="ob-tg-swap ob-tg-candidate" key="candidate" role="status">
          <p>
            <strong data-analytics-public>Is this you?</strong>{' '}
            <span data-analytics-private>
              {state.candidate.name}
              {state.candidate.username && ` @${state.candidate.username}`}
            </span>
          </p>
          <div className="ob-tg-buttons" data-analytics-public>
            <Button disabled={busy} onClick={() => void telegramAction('confirm')}>
              {busy ? 'Confirming…' : 'Confirm'}
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => void telegramAction('pairing')}>
              Not me
            </Button>
          </div>
        </div>
      );
    if (liveUrl || busy || !state.saved)
      return (
        <div className="ob-tg-swap ob-tg-waiting" key="waiting" role="status" data-analytics-public>
          <Spinner />
          {liveUrl ? 'Waiting for your message…' : 'Creating your code…'}
        </div>
      );
    return (
      <div className="ob-tg-swap" key="expired">
        <Button
          variant="outline"
          className="ob-tg-action"
          data-analytics-public
          onClick={() => void telegramAction('pairing')}
        >
          Get a new code
        </Button>
      </div>
    );
  }

  const actions = [
    <Button
      variant="outline"
      className="ob-tg-action"
      data-analytics-public
      onClick={() => {
        setError('');
        setHasToken(true);
      }}
    >
      I have my token
    </Button>,
    <form className="ob-tg-form" onSubmit={(event) => void submit(event)} noValidate>
      <Input
        ref={input}
        type="password"
        className="ob-mono"
        autoComplete="off"
        spellCheck={false}
        placeholder="123456789:AAF…"
        aria-label="Bot token"
        aria-invalid={Boolean(message) || undefined}
        data-analytics-private
        value={token}
        disabled={busy}
        onChange={(event) => {
          setToken(event.target.value);
          setTokenError('');
          setError('');
        }}
        onPaste={(event) => {
          const text = event.clipboardData.getData('text/plain');
          if (!/[\r\n]/.test(text)) return;
          event.preventDefault();
          const input = event.currentTarget;
          input.setRangeText(
            text.replace(/[\r\n]+/g, ' '),
            input.selectionStart ?? input.value.length,
            input.selectionEnd ?? input.value.length,
            'end',
          );
          setToken(input.value);
          setTokenError('');
          setError('');
        }}
      />
      <Button type="submit" variant="outline" disabled={busy || unavailable} data-analytics-public>
        {busy && <Spinner />}
        {busy ? 'Checking' : 'Save'}
      </Button>
    </form>,
    pairing(),
  ];

  return (
    <section className="ob-step ob-step-wide ob-telegram">
      <div data-analytics-public>
        <Messages
          revealed={revealed}
          typing={typing}
          items={[
            <Bubble>Want me in your pocket?</Bubble>,
            <Bubble>
              Connect Telegram and you can message me from your phone, wherever you are. It takes
              about a minute.
            </Bubble>,
          ]}
        />
      </div>
      <Rise show={revealed >= 3 && Boolean(settings || loadError)} className="ob-tg-card">
        <div className="ob-tg-steps">
          <div className="ob-tg-heading" data-analytics-public>
            <span className="ob-tg-logo">
              <Send size={18} aria-hidden="true" />
            </span>
            <p>Telegram</p>
          </div>
          <ol>
            {steps.map((step, index) => {
              const status =
                index + 1 < current ? 'done' : index + 1 === current ? 'active' : 'next';
              const active = status === 'active';
              return (
                <li
                  key={step.title}
                  className="ob-tg-item"
                  data-state={status}
                  aria-current={active ? 'step' : undefined}
                >
                  <span className="ob-tg-badge" aria-hidden="true">
                    <span>{index + 1}</span>
                    <Check size={14} strokeWidth={3} />
                  </span>
                  <div className="ob-tg-body">
                    <div className="ob-tg-text" data-analytics-public>
                      <p className="ob-tg-title">{step.title}</p>
                      <p>{step.body}</p>
                    </div>
                    <Grow open={active}>
                      <div className="ob-tg-extra">
                        {actions[index]}
                        {active && message && (
                          <p className="ob-tg-error" role="alert">
                            {message}
                          </p>
                        )}
                        {active && index === 1 && unavailable && (
                          <p className="ob-tg-error" role="alert">
                            {hosted
                              ? 'Telegram setup isn’t available right now. Try again later.'
                              : 'I need my secure key store set up on this computer before I can save your bot.'}
                          </p>
                        )}
                      </div>
                    </Grow>
                  </div>
                </li>
              );
            })}
          </ol>
        </div>
        <div className="ob-tg-panel">
          <Rise show={view === 'father'} className="ob-tg-layer">
            <Code url={botFather} title="QR code that opens BotFather in Telegram" />
            <p className="ob-tg-caption" data-analytics-public>
              Opens @BotFather in Telegram
            </p>
            <a
              className="ob-tg-open"
              href={botFather}
              target="_blank"
              rel="noopener noreferrer"
              data-analytics-public
            >
              On this computer? Open Telegram
            </a>
          </Rise>
          <Rise show={view === 'bot'} className="ob-tg-layer">
            <Code url={liveUrl} loading={busy} title="QR code that opens your bot in Telegram" />
            <p className="ob-tg-caption" data-analytics-private>
              Opens {handle} in Telegram
            </p>
            {liveUrl && (
              <a
                className="ob-tg-open"
                href={liveUrl}
                target="_blank"
                rel="noopener noreferrer"
                data-analytics-public
              >
                On this computer? Open Telegram
              </a>
            )}
          </Rise>
          <Rise show={view === 'paired'} className="ob-tg-layer ob-tg-done">
            <span className="ob-tg-check">
              <Check size={32} strokeWidth={2.5} aria-hidden="true" />
            </span>
            <p className="ob-tg-paired" data-analytics-private>
              Paired with {handle}
            </p>
            <p className="ob-tg-caption" data-analytics-public>
              Say hi from your phone anytime.
            </p>
          </Rise>
        </div>
      </Rise>
      <Footer
        show={revealed >= 4}
        onBack={onBack}
        onSkip={state.paired ? undefined : onNext}
        onNext={onNext}
        nextDisabled={!state.paired}
      />
    </section>
  );
}
