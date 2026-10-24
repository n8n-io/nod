import { useState } from 'react';
import { Check, ExternalLink, LoaderCircle } from './icons';
import { QRCodeSVG } from 'qrcode.react';
import type { ChannelSetupSummary } from '../../shared/contracts';
import { telegramState } from '../hooks/use-channel-settings';
import { telegramIdentity } from '../lib/secondary-pages';
import { Button, Field, Input, Notice } from './ui';

function TelegramLink({
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
  manual,
  fields,
  busy,
  error,
  unavailable = false,
  allowWebhook = false,
  onField,
  onVerify,
  onConfirm,
  onNewLink,
  onManual,
  onSaveId,
}: {
  setup?: ChannelSetupSummary;
  pairingUrl: string | null;
  manual: boolean;
  fields: Record<string, string>;
  busy: boolean;
  error: string;
  unavailable?: boolean;
  allowWebhook?: boolean;
  onField(name: string, value: string): void;
  onVerify(event: React.FormEvent): void;
  onConfirm(): void;
  onNewLink(): void;
  onManual(value: boolean): void;
  onSaveId(event: React.FormEvent): void;
}) {
  const [hasToken, setHasToken] = useState(false);
  const [tokenError, setTokenError] = useState('');
  const [copyResult, setCopyResult] = useState<{ url: string; ok: boolean }>();
  const state = telegramState(setup);
  const disabled = busy || unavailable;
  const candidate = manual ? undefined : state.candidate;
  const current = state.paired ? 5 : candidate ? 4 : state.saved ? 3 : hasToken ? 2 : 1;
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
  const steps = ['Create a bot', 'Paste the bot token', 'Open your bot', 'Confirm your account'];
  const setupError =
    error ||
    (unavailable && !state.paired
      ? 'Set up the secure key store on this computer to connect Telegram.'
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
      {state.paired ? (
        <div className="telegram-setup-connected" role="status">
          <Check size={20} aria-hidden="true" />
          <div>
            <strong data-analytics-private>
              {setup?.accountHandle ?? 'Your bot'} is connected
            </strong>
            <p data-analytics-private>
              Only{' '}
              {telegramIdentity(setup!.allowedUserId!, setup?.pairedUser, setup?.pairedUsername)}{' '}
              can message nod.
            </p>
            <p>Keep nod running to receive messages.</p>
          </div>
        </div>
      ) : (
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
                        Scan to open <strong>@BotFather</strong> on your phone, or open Telegram on
                        this computer.
                      </TelegramLink>
                      <p>
                        Send <code>/newbot</code>. Choose a name, then a username ending in{' '}
                        <code>bot</code>, such as <code>my_nod_bot</code>.
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
                      <p>BotFather sends you a token. Copy its full reply or just the token.</p>
                      <Field
                        label="BotFather message or token"
                        hint="Encrypted when saved. Never sent in chat."
                      >
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
                      {allowWebhook && (
                        <details className="telegram-setup-advanced">
                          <summary>Advanced: use a webhook</summary>
                          <Field
                            label="Public HTTPS callback"
                            hint="Leave blank to receive messages locally."
                          >
                            <Input
                              type="url"
                              pattern="https://.*"
                              placeholder="https://your-domain.example/api/webhooks/telegram"
                              value={fields.webhookUrl ?? ''}
                              onChange={(event) => onField('webhookUrl', event.target.value)}
                            />
                          </Field>
                        </details>
                      )}
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
                          <p>Your bot is saved, but nod could not start receiving messages.</p>
                          <Button
                            size="sm"
                            data-telegram-primary
                            disabled={disabled}
                            onClick={onNewLink}
                          >
                            {busy ? 'Connecting…' : 'Retry connection'}
                          </Button>
                        </>
                      ) : manual ? (
                        <form
                          className="telegram-setup-content"
                          onSubmit={(event) => {
                            event.preventDefault();
                            if (!disabled) onSaveId(event);
                          }}
                        >
                          <p>
                            Message{' '}
                            <a
                              href="https://t.me/userinfobot"
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              @userinfobot
                            </a>{' '}
                            in Telegram. Paste the ID it sends you.
                          </p>
                          <Field
                            label="Your Telegram user ID"
                            hint="Only this ID will be able to message nod."
                          >
                            <Input
                              inputMode="numeric"
                              pattern="[1-9][0-9]{0,15}"
                              required
                              autoFocus
                              placeholder="123456789"
                              disabled={disabled}
                              data-analytics-private
                              value={fields.allowedUserId ?? ''}
                              onChange={(event) => onField('allowedUserId', event.target.value)}
                            />
                          </Field>
                          <div className="telegram-setup-actions">
                            <Button type="submit" size="sm" disabled={disabled}>
                              {busy ? 'Saving…' : 'Save ID'}
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              disabled={busy}
                              onClick={() => onManual(false)}
                            >
                              Use QR code
                            </Button>
                          </div>
                        </form>
                      ) : (
                        <>
                          {liveUrl ? (
                            <>
                              <TelegramLink
                                url={liveUrl}
                                title="Scan to open your bot and pair Telegram"
                              >
                                Scan this new code or open Telegram below. Press{' '}
                                <strong>Start</strong> in your bot’s chat.
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
                                  <p>
                                    If Start does not connect, paste this command in your bot’s
                                    chat.
                                  </p>
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
                                Waiting for you to press Start…
                              </p>
                              <p>This code expires after 15 minutes.</p>
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
                          <button
                            type="button"
                            className="telegram-setup-manual"
                            disabled={busy}
                            onClick={() => onManual(true)}
                          >
                            Enter your user ID instead
                          </button>
                        </>
                      )}
                    </div>
                  )}
                  {active && step === 4 && candidate && (
                    <div className="telegram-setup-content">
                      <p>Is this you? Check the name and username against your Telegram profile.</p>
                      <p className="telegram-setup-identity" role="status" data-analytics-private>
                        {telegramIdentity(candidate.id, candidate.name, candidate.username)}
                      </p>
                      <p>Only this account will be able to message nod.</p>
                      <div className="telegram-setup-actions">
                        <Button
                          size="sm"
                          data-telegram-primary
                          disabled={disabled}
                          onClick={onConfirm}
                        >
                          {busy ? 'Confirming…' : 'Confirm'}
                        </Button>
                        <Button variant="ghost" size="sm" disabled={disabled} onClick={onNewLink}>
                          Not me
                        </Button>
                      </div>
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
