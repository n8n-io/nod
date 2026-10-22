import { useEffect, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import type { ChannelLinkStatus, ChannelSetupSummary } from '../../shared/contracts';
import { api, errorMessage } from '../lib/api';
import { Button, Checkbox, Field, Input, Notice } from './ui';

export function WhatsAppSetup({
  setup,
  busy,
  ready,
  error,
  onSave,
  onRefresh,
  onCloud,
  onDone,
}: {
  setup?: ChannelSetupSummary;
  busy: boolean;
  ready: boolean;
  error: string;
  onSave(input: {
    mode: 'bot' | 'self-chat';
    allowedNumber?: string;
    policyConfirmed: true;
  }): Promise<boolean>;
  onRefresh(): Promise<unknown>;
  onCloud(): void;
  onDone(): void;
}) {
  const [mode, setMode] = useState<'bot' | 'self-chat'>(setup?.linkMode ?? 'bot');
  const [number, setNumber] = useState('');
  const [policy, setPolicy] = useState(false);
  const [link, setLink] = useState<ChannelLinkStatus>();
  const [failure, setFailure] = useState('');
  const [restarting, setRestarting] = useState(false);
  const saved = Boolean(setup?.enabled && setup.mode === 'linked');
  useEffect(() => {
    if (!saved) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let last: ChannelLinkStatus | undefined;
    async function poll() {
      try {
        const next = await api<ChannelLinkStatus>('/api/channel-settings/whatsapp/pairing', {
          signal: controller.signal,
          cache: 'no-store',
        });
        if (controller.signal.aborted) return;
        setLink(next);
        setFailure('');
        if (next.state === 'connected' && last?.state !== 'connected') void onRefresh();
        last = next;
      } catch (cause) {
        if (!controller.signal.aborted) setFailure(errorMessage(cause));
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(() => void poll(), 2000);
      }
    }
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
      if (last?.pairingId && last.state !== 'connected')
        void api('/api/channel-settings/whatsapp/pairing', {
          method: 'DELETE',
          body: JSON.stringify({ pairingId: last.pairingId }),
        })
          .then(() => onRefresh())
          .catch(() => {});
    };
  }, [saved]);

  async function restart() {
    if (busy || restarting) return;
    setRestarting(true);
    try {
      await api('/api/channel-settings/whatsapp/pairing', { method: 'POST', body: '{}' });
      setLink(undefined);
      setFailure('');
      await onRefresh();
    } catch (cause) {
      setFailure(errorMessage(cause));
    } finally {
      setRestarting(false);
    }
  }

  const state = link?.state ?? setup?.connectionState ?? 'connecting';
  const linkedNumber = (link?.accountHandle ?? setup?.accountHandle)?.replace(/^\+/, '');
  const chatUrl =
    linkedNumber && /^\d{7,15}$/.test(linkedNumber) ? `https://wa.me/${linkedNumber}` : undefined;
  return (
    <div className="channel-wizard-step" data-analytics-private>
      {(error || failure) && <Notice>{error || failure}</Notice>}
      {!saved ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (policy)
              void onSave({
                mode,
                ...(mode === 'bot' ? { allowedNumber: number.trim() } : {}),
                policyConfirmed: true,
              });
          }}
        >
          <fieldset disabled={busy} className="channel-requirements">
            <legend>Choose how you will message nod</legend>
            <label>
              <input
                type="radio"
                name="whatsapp-mode"
                checked={mode === 'bot'}
                onChange={() => setMode('bot')}
              />{' '}
              Separate bot number
            </label>
            <label>
              <input
                type="radio"
                name="whatsapp-mode"
                checked={mode === 'self-chat'}
                onChange={() => setMode('self-chat')}
              />{' '}
              Use my own number
            </label>
          </fieldset>
          {mode === 'bot' ? (
            <>
              <p>
                Register a second number in WhatsApp or the WhatsApp Business app. You will link
                that account to nod.
              </p>
              <Field
                label="Your personal WhatsApp number"
                hint="Include the country code, without + or spaces. Only this number can start work."
              >
                <Input
                  type="tel"
                  inputMode="tel"
                  autoComplete="tel"
                  pattern="[0-9]{7,15}"
                  maxLength={15}
                  required
                  value={number}
                  onChange={(event) => setNumber(event.target.value)}
                  disabled={busy}
                />
              </Field>
            </>
          ) : (
            <p>
              Link your own account, then open <strong>Message yourself</strong> in WhatsApp to talk
              to nod. Other chats stay outside nod.
            </p>
          )}
          <p>
            This connection uses an unofficial WhatsApp client. WhatsApp can restrict the account or
            change how it connects.
          </p>
          <label className="channel-policy">
            <Checkbox
              checked={policy}
              required
              disabled={busy}
              onChange={(event) => setPolicy(event.target.checked)}
            />
            <span>
              I understand the account risk and have checked the{' '}
              <a
                href="https://www.whatsapp.com/legal/terms-of-service"
                target="_blank"
                rel="noopener noreferrer"
              >
                WhatsApp terms
              </a>
              .
            </span>
          </label>
          <div className="channel-wizard-actions">
            <Button type="button" variant="ghost" onClick={onDone} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !ready || !policy}>
              {busy ? 'Preparing connection…' : 'Show QR code'}
            </Button>
          </div>
          <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={onCloud}>
            Use Meta Cloud API instead
          </Button>
        </form>
      ) : (
        <>
          <div role="status" aria-live="polite">
            {state === 'connected' ? (
              <>
                <p>
                  <strong>WhatsApp is connected</strong>
                </p>
                <p>
                  {link?.accountName} {link?.accountHandle}
                </p>
                <p>
                  {setup?.linkMode === 'self-chat'
                    ? 'Open Message yourself in WhatsApp and send nod a message.'
                    : 'From your personal WhatsApp, send a message to the linked number.'}
                </p>
              </>
            ) : state === 'awaiting_scan' ? (
              <>
                <p>
                  Open the WhatsApp account you want to link. Select{' '}
                  <strong>Settings → Linked Devices → Link a Device</strong>, then scan this code.
                </p>
                {link?.qr && link.expiresAt && Date.parse(link.expiresAt) > Date.now() ? (
                  <div className="telegram-setup-qr">
                    <QRCodeSVG
                      value={link.qr}
                      size={196}
                      marginSize={4}
                      level="M"
                      title="Link WhatsApp to nod"
                    />
                  </div>
                ) : (
                  <p>Waiting for a new QR code…</p>
                )}
              </>
            ) : state === 'connecting' || state === 'disconnected' ? (
              <p>
                {state === 'connecting'
                  ? 'Connecting to WhatsApp…'
                  : 'WhatsApp is disconnected. nod is trying to connect again.'}
              </p>
            ) : (
              <Notice>
                {state === 'expired'
                  ? 'The QR setup expired. Start again to get a new code.'
                  : state === 'logged_out'
                    ? 'WhatsApp signed out this device. Link the account again.'
                    : 'WhatsApp could not connect. Check your connection, then try again.'}
              </Notice>
            )}
          </div>
          <div className="channel-wizard-actions">
            {state === 'connected' ? (
              <>
                {chatUrl && (
                  <Button asChild variant="outline">
                    <a href={chatUrl} target="_blank" rel="noopener noreferrer">
                      Open WhatsApp
                    </a>
                  </Button>
                )}
                <Button type="button" onClick={onDone}>
                  Done
                </Button>
              </>
            ) : (
              <>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={onDone}
                  disabled={busy || restarting}
                >
                  Close
                </Button>
                <Button type="button" onClick={() => void restart()} disabled={busy || restarting}>
                  {restarting ? 'Preparing connection…' : 'Start again'}
                </Button>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}
