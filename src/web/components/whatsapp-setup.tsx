import { useEffect, useRef, useState } from 'react';
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
  onDisconnect,
  selfChatOnly = false,
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
  onCloud?(): void;
  onDone(): void;
  onDisconnect?(): void;
  selfChatOnly?: boolean;
}) {
  const [mode, setMode] = useState<'bot' | 'self-chat'>(
    selfChatOnly ? 'self-chat' : (setup?.linkMode ?? 'bot'),
  );
  const [number, setNumber] = useState('');
  const [policy, setPolicy] = useState(false);
  const [link, setLink] = useState<ChannelLinkStatus>();
  const [failure, setFailure] = useState('');
  const [restarting, setRestarting] = useState(false);
  const currentLink = useRef<ChannelLinkStatus | undefined>(undefined);
  const visible = useRef(false);
  const restartPending = useRef(false);
  const revision = useRef(0);
  const saved = Boolean(setup?.enabled && setup.mode === 'linked');
  async function cancel(link?: ChannelLinkStatus) {
    if (!link?.pairingId || link.state === 'connected') return;
    await api('/api/channel-settings/whatsapp/pairing', {
      method: 'DELETE',
      body: JSON.stringify({ pairingId: link.pairingId }),
    })
      .then(() => onRefresh())
      .catch(() => {});
  }
  useEffect(() => {
    if (!saved) return;
    visible.current = true;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      const version = revision.current;
      try {
        if (restartPending.current) return;
        const next = await api<ChannelLinkStatus>('/api/channel-settings/whatsapp/pairing', {
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
          cache: 'no-store',
        });
        if (controller.signal.aborted || restartPending.current || version !== revision.current)
          return;
        setLink(next);
        setFailure('');
        if (next.state === 'connected' && currentLink.current?.state !== 'connected')
          void onRefresh();
        currentLink.current = next;
      } catch (cause) {
        if (!controller.signal.aborted && !restartPending.current && version === revision.current) {
          setLink((current) => (current ? { ...current, qr: undefined } : current));
          setFailure(errorMessage(cause));
        }
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(() => void poll(), 2000);
      }
    }
    void poll();
    return () => {
      visible.current = false;
      controller.abort();
      clearTimeout(timer);
      void cancel(currentLink.current);
    };
  }, [saved]);

  useEffect(() => {
    const expiresAt = link?.expiresAt;
    if (!link?.qr || !expiresAt) return;
    const timer = setTimeout(
      () => {
        setLink((current) =>
          current?.expiresAt === expiresAt ? { ...current, qr: undefined } : current,
        );
      },
      Math.max(0, Date.parse(expiresAt) - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [link?.qr, link?.expiresAt]);

  async function restart() {
    const pairingId = currentLink.current?.pairingId;
    if (busy || restartPending.current || !pairingId) return;
    restartPending.current = true;
    revision.current++;
    setRestarting(true);
    setLink((current) => (current ? { ...current, qr: undefined } : current));
    try {
      const next = await api<ChannelLinkStatus>('/api/channel-settings/whatsapp/pairing', {
        method: 'POST',
        body: JSON.stringify({ pairingId }),
      });
      currentLink.current = next;
      if (!visible.current) {
        await cancel(next);
        return;
      }
      setLink(next);
      setFailure('');
      await onRefresh();
    } catch (cause) {
      if (visible.current) setFailure(errorMessage(cause));
    } finally {
      restartPending.current = false;
      if (visible.current) setRestarting(false);
    }
  }

  const state = link?.state ?? setup?.connectionState ?? 'connecting';
  const hasAccount = state === 'connected' || Boolean(link?.accountHandle || setup?.accountHandle);
  const canRestart = state === 'failed' || state === 'expired' || state === 'logged_out';
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
                mode: selfChatOnly ? 'self-chat' : mode,
                ...(!selfChatOnly && mode === 'bot' ? { allowedNumber: number.trim() } : {}),
                policyConfirmed: true,
              });
          }}
        >
          {!selfChatOnly && (
            <fieldset disabled={busy} className="channel-modes">
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
          )}
          {!selfChatOnly && mode === 'bot' ? (
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
              Use <strong>Message yourself</strong> to chat with nod. Other chats stay outside nod.
            </p>
          )}
          <p>This uses an unofficial connection. WhatsApp may restrict your account.</p>
          <label className="channel-policy">
            <Checkbox
              checked={policy}
              required
              disabled={busy}
              onChange={(event) => setPolicy(event.target.checked)}
            />
            <span>
              I understand this risk and have checked the{' '}
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
            <Button type="submit" disabled={busy || !ready || !policy}>
              {busy ? 'Preparing connection…' : 'Show QR code'}
            </Button>
          </div>
          {!selfChatOnly && onCloud && (
            <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={onCloud}>
              Use Meta Cloud API instead
            </Button>
          )}
        </form>
      ) : (
        <>
          <div className="whatsapp-setup-status" role="status" aria-live="polite">
            {state === 'connected' ? (
              <>
                <div className="whatsapp-connected-identity">
                  <strong>
                    {link?.accountName || setup?.accountName || 'Your WhatsApp account'}
                  </strong>
                  {(link?.accountHandle || setup?.accountHandle) && (
                    <span>{link?.accountHandle || setup?.accountHandle}</span>
                  )}
                </div>
                <p>
                  {chatUrl ? (
                    <a
                      className="channel-external-link"
                      href={chatUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      Open WhatsApp
                    </a>
                  ) : (
                    'Open WhatsApp'
                  )}
                  {setup?.linkMode === 'self-chat'
                    ? ', select Message yourself, and send nod a message.'
                    : ' on your phone and send a message to the linked number.'}
                </p>
              </>
            ) : state === 'awaiting_scan' ? (
              <>
                <p>
                  In WhatsApp, open <strong>Settings → Linked Devices → Link a Device</strong>, then
                  scan this code.
                </p>
                {link?.qr && link.expiresAt && Date.parse(link.expiresAt) > Date.now() ? (
                  <div className="whatsapp-setup-qr">
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
          {!hasAccount && link?.pairingId && !canRestart && (
            <p className="whatsapp-setup-hint">Closing this window cancels setup.</p>
          )}
          {(hasAccount || canRestart) && (
            <div className="channel-wizard-actions">
              {hasAccount && onDisconnect && (
                <Button
                  type="button"
                  variant="ghost"
                  disabled={busy || restarting}
                  onClick={onDisconnect}
                >
                  Disconnect
                </Button>
              )}
              {state === 'connected' && (
                <Button type="button" onClick={onDone}>
                  Done
                </Button>
              )}
              {canRestart && (
                <Button
                  type="button"
                  onClick={() => void restart()}
                  disabled={busy || restarting || !link?.pairingId}
                >
                  {restarting ? 'Preparing connection…' : 'Start again'}
                </Button>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
