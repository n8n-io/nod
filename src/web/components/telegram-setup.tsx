import { useState } from 'react';
import { Check, ExternalLink, LoaderCircle } from './icons';
import { QRCodeSVG } from 'qrcode.react';
import type { ChannelSetupSummary } from '../../shared/contracts';
import { telegramState } from '../hooks/use-channel-settings';
import { Button, Field, Input, Notice } from './ui';

export function TelegramLink({
  url,
  title,
  children,
}: {
  url: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="telegram-setup-link">
      <div className="telegram-setup-qr" data-analytics-private>
        <QRCodeSVG value={url} size={152} marginSize={4} level="M" title={title} />
      </div>
      <div>
        <p>{children}</p>
        <Button asChild variant="outline" size="sm">
          <a data-telegram-primary href={url} target="_blank" rel="noopener noreferrer">
            Open Telegram
            <ExternalLink size={14} />
          </a>
        </Button>
      </div>
    </div>
  );
}

export function TelegramSetup({
  setup,
  pairingUrl,
  fields,
  busy,
  error,
  unavailable = false,
  onField,
  onVerify,
  onNewLink,
}: {
  setup?: ChannelSetupSummary;
  pairingUrl: string | null;
  fields: Record<string, string>;
  busy: boolean;
  error: string;
  unavailable?: boolean;
  onField(name: string, value: string): void;
  onVerify(event: React.FormEvent): void;
  onNewLink(): void;
}) {
  const [hasToken, setHasToken] = useState(false);
  const [tokenError, setTokenError] = useState('');
  const [copyResult, setCopyResult] = useState<{ url: string; ok: boolean }>();
  const state = telegramState(setup);
  const disabled = busy || unavailable;
  const current = state.saved ? 3 : hasToken ? 2 : 1;
  const liveUrl = state.waiting ? pairingUrl : null;
  let pairingCommand = '';
  if (liveUrl && setup?.accountHandle) {
    try {
      const target = new URL(liveUrl);
      const code = target.searchParams.get('start');
      if (
        target.origin === 'https://t.me' &&
        !target.username &&
        !target.password &&
        !target.hash &&
        target.pathname.toLowerCase() === `/${setup.accountHandle.slice(1).toLowerCase()}` &&
        [...target.searchParams].length === 1 &&
        code &&
        /^[A-Za-z0-9_-]{32}$/.test(code)
      )
        pairingCommand = `/start ${code}`;
    } catch {}
  }
  const steps = ['Create a bot', 'Add token', 'Link your account'];
  const setupError =
    error ||
    (unavailable && !state.paired && !setup?.managed
      ? 'Set up Nod’s secure key store to connect Telegram.'
      : '');

  function verify(event: React.FormEvent) {
    event.preventDefault();
    if (disabled) return;
    if (!fields.botToken?.trim()) {
      setTokenError('Paste your bot token first.');
      return;
    }
    setTokenError('');
    onVerify(event);
  }

  return (
    <div className="telegram-setup">
      {setupError && <Notice>{setupError}</Notice>}
      {setup?.managed && (
        <p>
          Telegram is managed by the server environment. Change its settings there and restart Nod.
        </p>
      )}
      {state.paired || setup?.managed ? null : (
        <ol className="telegram-setup-steps">
          {steps.map((title, index) => {
            const step = index + 1;
            const active = current === step;
            const done = current > step;
            return (
              <li
                key={title}
                data-state={done ? 'done' : active ? 'active' : 'next'}
                aria-current={active ? 'step' : undefined}
              >
                <span className="telegram-setup-marker" aria-hidden="true">
                  {done ? <Check size={14} /> : step}
                </span>
                <div className="telegram-setup-step">
                  <strong>{title}</strong>
                  {active && step === 1 && (
                    <div className="telegram-setup-content">
                      <TelegramLink
                        url="https://t.me/BotFather"
                        title="Scan to open BotFather in Telegram"
                      >
                        Open <strong>@BotFather</strong> or scan the code.
                      </TelegramLink>
                      <p>
                        Send <code>/newbot</code> and follow the instructions to create your bot.
                      </p>
                      <Button
                        size="sm"
                        data-telegram-token-step
                        onClick={() => {
                          setTokenError('');
                          setHasToken(true);
                        }}
                      >
                        I have my token
                      </Button>
                    </div>
                  )}
                  {active && step === 2 && (
                    <form className="telegram-setup-content" onSubmit={verify}>
                      <p>Paste the token or full reply from BotFather.</p>
                      <Field label="Bot token">
                        <Input
                          type="password"
                          autoComplete="off"
                          autoFocus
                          required
                          spellCheck={false}
                          placeholder="123456789:AAF…"
                          aria-invalid={Boolean(tokenError) || undefined}
                          data-analytics-private
                          value={fields.botToken ?? ''}
                          disabled={disabled}
                          onChange={(event) => {
                            setTokenError('');
                            onField('botToken', event.target.value);
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
                            setTokenError('');
                            onField('botToken', input.value);
                          }}
                        />
                      </Field>
                      {tokenError && <p role="alert">{tokenError}</p>}
                      <div className="telegram-setup-actions">
                        <Button type="submit" size="sm" disabled={disabled}>
                          {busy ? 'Connecting…' : 'Connect bot'}
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          disabled={busy}
                          onClick={() => {
                            setTokenError('');
                            setHasToken(false);
                          }}
                        >
                          Back
                        </Button>
                      </div>
                    </form>
                  )}
                  {active && step === 3 && (
                    <div className="telegram-setup-content">
                      {state.needsDelivery ? (
                        <>
                          <p>Your bot is saved, but Nod could not start receiving messages.</p>
                          <Button
                            size="sm"
                            data-telegram-primary
                            disabled={disabled}
                            onClick={onNewLink}
                          >
                            {busy ? 'Connecting…' : 'Retry connection'}
                          </Button>
                        </>
                      ) : (
                        <>
                          {liveUrl ? (
                            <>
                              <TelegramLink
                                url={liveUrl}
                                title="Scan to open your bot and pair Telegram"
                              >
                                Open your bot or scan the code, then press <strong>Start</strong>.
                              </TelegramLink>
                              {pairingCommand && (
                                <div data-analytics-private>
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    disabled={disabled}
                                    onClick={async () => {
                                      try {
                                        await navigator.clipboard.writeText(pairingCommand);
                                        setCopyResult({ url: liveUrl, ok: true });
                                      } catch {
                                        setCopyResult({ url: liveUrl, ok: false });
                                      }
                                    }}
                                  >
                                    {copyResult?.url === liveUrl && copyResult.ok
                                      ? 'Copied'
                                      : 'Copy pairing command'}
                                  </Button>

                                  {copyResult?.url === liveUrl && !copyResult.ok && (
                                    <Input
                                      aria-label="Pairing command"
                                      readOnly
                                      value={pairingCommand}
                                    />
                                  )}
                                </div>
                              )}
                              <p className="telegram-setup-waiting" role="status">
                                <LoaderCircle size={14} aria-hidden="true" />
                                Waiting for Start…
                              </p>
                              <p>Link expires in 15 minutes.</p>
                            </>
                          ) : (
                            <>
                              <p>
                                {state.expired
                                  ? 'This code has expired. Get a new one, then press Start in Telegram.'
                                  : 'Get a code to open your bot and link your Telegram account.'}
                              </p>
                              <Button
                                size="sm"
                                data-telegram-primary
                                disabled={disabled}
                                onClick={onNewLink}
                              >
                                {busy ? 'Creating code…' : 'Get a new code'}
                              </Button>
                            </>
                          )}
                        </>
                      )}
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
