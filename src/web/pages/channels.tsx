import { PageTitle } from '../components/page-title';
import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Check, ExternalLink, X } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import type { ChannelProvider, ChannelSetupSummary } from '../../shared/contracts';
import { api, errorMessage } from '../lib/api';
import {
  channelLabel,
  channelSetupBody,
  telegramBotUrl,
  telegramIdentity,
  type ChannelResponse,
  type ChannelSettings,
} from '../lib/secondary-pages';
import {
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
  Field,
  Input,
  Loading,
  Notice,
} from '../components/ui';

const providers = [
  {
    id: 'telegram' as const,
    name: 'Telegram',
    description: 'Chat with Otto in Telegram.',
  },
  {
    id: 'whatsapp' as const,
    name: 'WhatsApp',
    description: 'Chat with Otto in WhatsApp.',
    comingSoon: true,
  },
];
const whatsappSteps = [
  'Before you begin',
  'Choose the numbers',
  'Verify your business app',
  'Set up message delivery',
];

function ExternalLinkText({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a className="channel-external-link" href={href} target="_blank" rel="noopener noreferrer">
      {children}
      <ExternalLink size={12} />
    </a>
  );
}

export function ChannelSetupStep({
  provider,
  step,
  fields,
  onField,
  policy,
  onPolicy,
  hosted = false,
}: {
  provider: ChannelProvider;
  step: number;
  fields: Record<string, string>;
  onField(name: string, value: string): void;
  policy: boolean;
  onPolicy(value: boolean): void;
  hosted?: boolean;
}) {
  const field = (name: string) => ({
    value: fields[name] ?? '',
    onChange: (event: React.ChangeEvent<HTMLInputElement>) => onField(name, event.target.value),
  });
  if (provider === 'telegram')
    return (
      <>
        <p>
          Open <ExternalLinkText href="https://t.me/BotFather">BotFather</ExternalLinkText> in
          Telegram and send <code>/newbot</code>. Choose a name and username, then paste the token
          it gives you.
        </p>
        <Field label="Bot token" hint="This stays outside chat and is encrypted when saved.">
          <Input type="password" autoComplete="off" required autoFocus {...field('botToken')} />
        </Field>
        {!hosted && (
          <details className="channel-advanced">
            <summary>Advanced: use a webhook</summary>
            <Field label="Public HTTPS callback" hint="Leave blank to receive messages locally.">
              <Input
                type="url"
                pattern="https://.*"
                placeholder="https://your-domain.example/api/webhooks/telegram"
                {...field('webhookUrl')}
              />
            </Field>
          </details>
        )}
      </>
    );
  if (step === 0)
    return (
      <>
        <p>
          Use a business bot number with Meta’s WhatsApp Cloud API. This does not connect your
          personal WhatsApp inbox.
        </p>
        <ul className="channel-requirements">
          <li>A Meta app with WhatsApp enabled</li>
          <li>A business sender number and its credentials</li>
          {!hosted && <li>A public HTTPS callback for messages</li>}
        </ul>
        <p>
          Replies are available for 24 hours after your message. Delayed proactive messages are not
          supported.
        </p>
        <label className="channel-policy">
          <Checkbox
            checked={policy}
            required
            onChange={(event) => onPolicy(event.target.checked)}
          />
          <span>
            I have checked that my use is allowed under the{' '}
            <ExternalLinkText href="https://www.whatsapp.com/legal/business-solution-terms">
              current WhatsApp terms
            </ExternalLinkText>
            .
          </span>
        </label>
      </>
    );
  if (step === 1)
    return (
      <>
        <Field
          label="Business phone number ID"
          hint="Find the sender ID in Meta’s WhatsApp API setup. This is not the phone number itself."
        >
          <Input
            inputMode="numeric"
            pattern="[0-9]+"
            required
            autoFocus
            {...field('phoneNumberId')}
          />
        </Field>
        <Field
          label="Your WhatsApp number"
          hint="International digits without +. Only messages from this number are accepted."
        >
          <Input
            inputMode="tel"
            pattern="[0-9]{7,15}"
            placeholder="351910000000"
            required
            {...field('allowedNumber')}
          />
        </Field>
      </>
    );
  if (step === 2)
    return (
      <>
        <p>Copy these from your Meta app. They stay outside chat and are encrypted when saved.</p>
        <Field label="Business access token">
          <Input type="password" autoComplete="off" required autoFocus {...field('accessToken')} />
        </Field>
        <Field label="Meta app secret">
          <Input type="password" autoComplete="off" required {...field('appSecret')} />
        </Field>
      </>
    );
  return (
    <>
      <p>
        {hosted
          ? 'After connecting, copy the callback URL into Meta and subscribe to messages.'
          : 'Use these same callback settings in Meta, then subscribe the app to messages. Expose only this route; keep the rest of Otto private.'}
      </p>
      {!hosted && (
        <Field
          label="Public HTTPS callback"
          hint="You can leave this blank and finish delivery setup later."
        >
          <Input
            type="url"
            pattern="https://.*"
            placeholder="https://your-domain.example/api/webhooks/whatsapp"
            autoFocus
            {...field('webhookUrl')}
          />
        </Field>
      )}
      <Field
        label="Webhook verification token"
        hint="Choose 16–256 letters, digits, underscores or hyphens. Use the same token in Meta; it will not be shown again."
      >
        <Input
          type="password"
          autoComplete="off"
          minLength={16}
          maxLength={256}
          pattern="[A-Za-z0-9_-]{16,256}"
          required
          {...field('verifyToken')}
        />
      </Field>
    </>
  );
}

export function ChannelAccount({
  provider,
  setup,
  configured,
  onDisconnect,
  onPair,
  busy,
  hosted = false,
}: {
  provider: ChannelProvider;
  setup?: ChannelSetupSummary;
  configured: boolean;
  onDisconnect(trigger: HTMLButtonElement): void;
  onPair?(): void;
  busy: boolean;
  hosted?: boolean;
}) {
  const botUrl = setup?.provider === 'telegram' ? telegramBotUrl(setup.accountHandle) : null;
  const name = setup?.accountName?.trim();
  const handle = setup?.accountHandle?.trim();
  const distinctHandle =
    handle &&
    name &&
    handle.replace(/^@/, '').toLowerCase() !== name.replace(/^@/, '').toLowerCase();
  const needsDelivery = Boolean(
    setup?.enabled &&
    (setup.webhookStatus === 'registration_pending' ||
      (setup.mode === 'webhook' && setup.webhookStatus !== 'registered')),
  );
  const needsPairing = Boolean(
    setup?.enabled && provider === 'telegram' && (!setup.allowedUserId || setup.pairingExpiresAt),
  );
  const statusLabel = channelLabel(setup, configured);
  return (
    <div className="channel-account">
      <div className="channel-account-row">
        <div className="channel-account-info">
          <div className="channel-account-label">
            <strong>{name || handle || 'Saved configuration'}</strong>
            {distinctHandle && <span>{handle}</span>}
          </div>
          {statusLabel && (
            <p
              className={`channel-account-status${needsDelivery || needsPairing ? ' needs-setup' : ''}`}
            >
              {statusLabel}
            </p>
          )}
        </div>
      </div>
      <div className="channel-account-actions">
        {provider === 'telegram' && (needsDelivery || needsPairing) ? (
          <Button variant="outline" size="sm" disabled={busy} onClick={onPair}>
            {needsDelivery ? 'Retry connection' : 'Finish setup'}
            <ArrowRight size={13} />
          </Button>
        ) : needsDelivery ? (
          <Dialog>
            <DialogTrigger asChild>
              <Button variant="outline" size="sm" disabled={busy}>
                Finish setup
                <ArrowRight size={13} />
              </Button>
            </DialogTrigger>
            <DialogContent className="channel-delivery-dialog">
              <DialogTitle>
                Finish {provider === 'telegram' ? 'Telegram' : 'WhatsApp'} setup
              </DialogTitle>
              <DialogDescription>
                {setup?.webhookStatus === 'registration_pending'
                  ? hosted
                    ? 'Delivery setup could not finish. Contact the person who hosts Otto.'
                    : 'Restart Otto to retry the saved setup.'
                  : 'Finish the callback in Meta and subscribe to messages.'}
              </DialogDescription>
              {setup?.webhookUrl && (!hosted || provider === 'whatsapp') && (
                <div className="channel-delivery-address">
                  <span>Callback URL</span>
                  <code>{setup.webhookUrl}</code>
                </div>
              )}
              {setup?.webhookStatus !== 'registration_pending' && (
                <p>Use the verification token you saved when connecting this channel.</p>
              )}
            </DialogContent>
          </Dialog>
        ) : botUrl ? (
          <Button asChild size="sm">
            <a href={botUrl} target="_blank" rel="noopener noreferrer">
              Start conversation
              <ExternalLink size={13} />
            </a>
          </Button>
        ) : null}
        <Button
          variant="ghost"
          size="icon"
          className="channel-remove"
          data-channel-remove={provider}
          aria-label={`Remove ${provider === 'telegram' ? 'Telegram' : 'WhatsApp'} channel`}
          title="Remove channel"
          disabled={busy}
          onClick={(event) => onDisconnect(event.currentTarget)}
        >
          <X size={15} aria-hidden="true" />
        </Button>
      </div>
    </div>
  );
}

function TelegramSetup({
  setup,
  pairingUrl,
  manual,
  fields,
  busy,
  error,
  hosted,
  onField,
  onVerify,
  onClose,
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
  hosted: boolean;
  onField(name: string, value: string): void;
  onVerify(event: React.FormEvent): void;
  onClose(): void;
  onConfirm(): void;
  onNewLink(): void;
  onManual(value: boolean): void;
  onSaveId(event: React.FormEvent): void;
}) {
  const [copied, setCopied] = useState(false);
  const saved = Boolean(setup?.enabled);
  const needsDelivery = saved && setup?.webhookStatus === 'registration_pending';
  const ready = saved && !needsDelivery;
  const paired = Boolean(ready && setup?.allowedUserId && !setup.pairingExpiresAt);
  const expiry = saved && !paired ? setup?.pairingExpiresAt : undefined;
  const expired = Boolean(expiry && Date.parse(expiry) <= Date.now());
  const candidate = ready && !paired && !expired && !manual ? setup?.pairingCandidate : undefined;
  const botUrl = telegramBotUrl(setup?.accountHandle);
  const identity =
    paired && setup?.allowedUserId
      ? telegramIdentity(setup.allowedUserId, setup.pairedUser, setup.pairedUsername)
      : '';
  return (
    <>
      <DialogTitle>{paired ? 'Telegram is connected' : 'Connect Telegram'}</DialogTitle>
      <DialogDescription className="channel-wizard-description">
        {paired
          ? hosted
            ? 'Send your bot a message to start.'
            : 'Send your bot a message to start. Otto must be running to reply.'
          : 'Add your bot, then confirm your Telegram account.'}
      </DialogDescription>
      {error && <Notice>{error}</Notice>}
      <ol className="telegram-checklist">
        <li className={saved ? 'is-done' : 'is-active'}>
          <span className="telegram-checklist-marker" aria-hidden="true">
            {saved ? <Check size={13} /> : '1'}
          </span>
          <div>
            <strong>
              {saved ? `${setup?.accountHandle ?? 'Your bot'} is verified` : 'Add your bot'}
            </strong>
            {!saved && (
              <form className="telegram-checklist-form" onSubmit={onVerify}>
                <ChannelSetupStep
                  provider="telegram"
                  step={0}
                  fields={fields}
                  onField={onField}
                  policy={false}
                  onPolicy={() => {}}
                  hosted={hosted}
                />
                <Button type="submit" size="sm" disabled={busy}>
                  {busy ? 'Connecting…' : 'Connect bot'}
                </Button>
              </form>
            )}
          </div>
        </li>
        <li className={paired ? 'is-done' : saved ? 'is-active' : 'is-next'}>
          <span className="telegram-checklist-marker" aria-hidden="true">
            {paired ? (
              <Check size={13} />
            ) : ready && !expired && !manual ? (
              <span className="channel-pairing-signal" />
            ) : (
              '2'
            )}
          </span>
          <div>
            <strong>
              {paired
                ? 'Only you can message Otto'
                : needsDelivery
                  ? 'Finish connecting your bot'
                  : manual
                    ? 'Enter your Telegram user ID'
                    : candidate
                      ? 'Is this you?'
                      : 'Press Start in Telegram'}
            </strong>
            {paired ? (
              <p>Only this Telegram account can message Otto: {identity}.</p>
            ) : !saved ? (
              <p>Then Otto finds your Telegram account, so that only you can message it.</p>
            ) : needsDelivery ? (
              <>
                {!error && (
                  <p>Otto could not start receiving messages. Retry the connection to continue.</p>
                )}
                <div className="telegram-checklist-actions">
                  <Button size="sm" data-telegram-primary disabled={busy} onClick={onNewLink}>
                    {busy ? 'Connecting…' : 'Retry connection'}
                  </Button>
                </div>
              </>
            ) : manual ? (
              <form className="telegram-checklist-form" onSubmit={onSaveId}>
                <p>
                  Open Telegram and send any message to{' '}
                  <ExternalLinkText href="https://t.me/userinfobot">@userinfobot</ExternalLinkText>.
                  It replies with your ID. Copy that number here.
                </p>
                <Field
                  label="Your Telegram user ID"
                  hint="Otto accepts messages only from this ID."
                >
                  <Input
                    inputMode="numeric"
                    pattern="[1-9][0-9]{0,15}"
                    placeholder="123456789"
                    required
                    autoFocus
                    value={fields.allowedUserId ?? ''}
                    onChange={(event) => onField('allowedUserId', event.target.value)}
                  />
                </Field>
                <div className="telegram-checklist-actions">
                  <Button type="submit" size="sm" disabled={busy}>
                    {busy ? 'Saving…' : 'Save ID'}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() => onManual(false)}
                  >
                    Use the Start link instead
                  </Button>
                </div>
              </form>
            ) : candidate ? (
              <>
                <p className="telegram-candidate" role="status">
                  <strong>
                    {telegramIdentity(candidate.id, candidate.name, candidate.username)}
                  </strong>
                </p>
                <p>
                  Compare this name{candidate.username ? ' and @username' : ''} with your profile in
                  Telegram Settings.
                </p>
                <div className="telegram-checklist-actions">
                  <Button size="sm" data-telegram-primary disabled={busy} onClick={onConfirm}>
                    {busy ? 'Confirming…' : 'Confirm'}
                  </Button>
                  <Button variant="ghost" size="sm" disabled={busy} onClick={onNewLink}>
                    Not me
                  </Button>
                </div>
              </>
            ) : (
              <>
                {expired || !pairingUrl ? (
                  <p>
                    {expired
                      ? 'This link has expired. Get a new link, then press Start again.'
                      : 'Get a start link, then press Start in Telegram.'}
                  </p>
                ) : (
                  <figure className="telegram-pairing-qr">
                    <QRCodeSVG
                      value={pairingUrl}
                      size={176}
                      marginSize={4}
                      level="M"
                      title="Open the Telegram pairing link on your phone"
                    />
                    <figcaption>Scan to start on mobile.</figcaption>
                  </figure>
                )}
                <div className="telegram-checklist-actions">
                  {expired || !pairingUrl ? (
                    <Button size="sm" data-telegram-primary disabled={busy} onClick={onNewLink}>
                      {busy ? 'Creating link…' : 'Get a new link'}
                    </Button>
                  ) : (
                    <>
                      <Button asChild size="sm">
                        <a
                          data-telegram-primary
                          href={pairingUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          Open Telegram app
                          <ExternalLink size={13} />
                        </a>
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() =>
                          void navigator.clipboard
                            ?.writeText(pairingUrl)
                            .then(() => setCopied(true))
                            .catch(() => {})
                        }
                      >
                        {copied ? 'Link copied' : 'Copy link for your phone'}
                      </Button>
                    </>
                  )}
                </div>
                <button
                  type="button"
                  className="telegram-manual-toggle"
                  disabled={busy}
                  onClick={() => onManual(true)}
                >
                  Enter your user ID instead
                </button>
              </>
            )}
          </div>
        </li>
      </ol>
      <div className="channel-wizard-actions">
        <Button variant="ghost" size="sm" disabled={busy} onClick={onClose}>
          {paired ? 'Done' : saved ? 'Close' : 'Cancel'}
        </Button>
        {paired && botUrl && (
          <Button asChild>
            <a data-telegram-primary href={botUrl} target="_blank" rel="noopener noreferrer">
              Start conversation
              <ExternalLink size={14} />
            </a>
          </Button>
        )}
      </div>
    </>
  );
}

export function Channels({ hosted = false }: { hosted?: boolean } = {}) {
  const [data, setData] = useState<ChannelResponse | null>(null);
  const [settings, setSettings] = useState<ChannelSettings | null>(null);
  const [error, setError] = useState('');
  const [loadError, setLoadError] = useState('');
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<ChannelProvider | null>(null);
  const [step, setStep] = useState(0);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [policy, setPolicy] = useState(false);
  const [pairingUrl, setPairingUrl] = useState<string | null>(null);
  const [manualId, setManualId] = useState(false);
  const [removing, setRemoving] = useState<ChannelProvider | null>(null);
  const [removeError, setRemoveError] = useState('');
  const request = useRef<AbortController | null>(null);
  const actionRequest = useRef<AbortController | null>(null);
  const page = useRef<HTMLDivElement>(null);
  const removeTrigger = useRef<HTMLButtonElement | null>(null);
  const removeProvider = useRef<ChannelProvider | null>(null);
  const channels = providers.map((provider) => {
    const setup = settings?.channels.find((item) => item.provider === provider.id);
    const configured = Boolean(
      data?.channels.some((item) => item.provider === provider.id && item.status === 'configured'),
    );
    return { provider, setup, configured, connected: Boolean(setup?.enabled || configured) };
  });
  const telegramSetup = channels[0].setup;
  const telegramWaiting = Boolean(
    editing === 'telegram' &&
    telegramSetup?.enabled &&
    telegramSetup.webhookStatus !== 'registration_pending' &&
    telegramSetup.pairingExpiresAt &&
    Date.parse(telegramSetup.pairingExpiresAt) > Date.now(),
  );
  const telegramStage =
    editing !== 'telegram'
      ? ''
      : [
          telegramSetup?.enabled,
          telegramSetup?.webhookStatus,
          telegramSetup?.allowedUserId,
          telegramSetup?.pairingCandidate?.id,
          telegramWaiting,
          pairingUrl,
          manualId,
        ].join(':');
  const connected = channels.filter((channel) => channel.connected);
  const available = channels.filter((channel) => !channel.connected);
  async function load() {
    request.current?.abort();
    const current = new AbortController();
    request.current = current;
    setLoading(true);
    try {
      const [status, setup] = await Promise.all([
        api<ChannelResponse>('/api/channels', { signal: current.signal }),
        api<ChannelSettings>('/api/channel-settings', { signal: current.signal }),
      ]);
      if (!current.signal.aborted) {
        setData(status);
        setSettings(setup);
        setLoadError('');
        return setup;
      }
    } catch (cause) {
      if (!current.signal.aborted) setLoadError(errorMessage(cause));
    } finally {
      if (!current.signal.aborted) setLoading(false);
    }
  }
  useEffect(() => {
    void load();
    const focus = () => void load();
    window.addEventListener('focus', focus);
    return () => {
      request.current?.abort();
      actionRequest.current?.abort();
      window.removeEventListener('focus', focus);
    };
  }, []);
  useEffect(() => {
    if (telegramStage)
      document.querySelector<HTMLElement>('[role="dialog"] [data-telegram-primary]')?.focus();
  }, [telegramStage]);
  useEffect(() => {
    if (!telegramWaiting) return;
    const timer = setInterval(() => void load(), 2000);
    return () => clearInterval(timer);
  }, [telegramWaiting]);
  function close() {
    setEditing(null);
    setFields({});
    setPolicy(false);
    setStep(0);
    setError('');
    setPairingUrl(null);
    setManualId(false);
  }
  function open(provider: ChannelProvider) {
    setFields({});
    setPolicy(false);
    setError('');
    setStep(0);
    setEditing(provider);
  }
  function acceptedSetup(channel: ChannelSetupSummary) {
    request.current?.abort();
    setSettings((current) =>
      current
        ? {
            ...current,
            channels: [
              ...current.channels.filter((item) => item.provider !== channel.provider),
              channel,
            ],
          }
        : current,
    );
    setData((current) =>
      current
        ? {
            ...current,
            error: null,
            channels: [
              ...current.channels.filter((item) => item.provider !== channel.provider),
              {
                provider: channel.provider,
                status: channel.enabled ? 'configured' : 'disabled',
                missing: [],
              },
            ],
          }
        : current,
    );
  }
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!editing || actionRequest.current || busy) return;
    if (editing === 'whatsapp' && step < whatsappSteps.length - 1) {
      setStep((value) => value + 1);
      return;
    }
    const current = new AbortController();
    actionRequest.current = current;
    setBusy(true);
    setError('');
    try {
      const result = await api<{ channel: ChannelSetupSummary; pairingUrl?: string }>(
        `/api/channel-settings/${editing}`,
        {
          method: 'PUT',
          body: JSON.stringify(channelSetupBody(editing, fields, policy)),
          signal: current.signal,
        },
      );
      if (current.signal.aborted) return;
      acceptedSetup(result.channel);
      if (editing === 'telegram') {
        setFields({});
        setPairingUrl(result.pairingUrl ?? null);
      } else close();
      void load();
    } catch (cause) {
      if (!current.signal.aborted) {
        if (editing === 'telegram') {
          const latest = await load();
          if (
            latest?.channels.some((channel) => channel.provider === 'telegram' && channel.enabled)
          )
            setFields({});
        }
        if (!current.signal.aborted) setError(errorMessage(cause));
      }
    } finally {
      if (actionRequest.current === current) actionRequest.current = null;
      if (!current.signal.aborted) setBusy(false);
    }
  }
  async function telegramAction(action: 'pairing' | 'confirm' | 'user', body: object = {}) {
    if (actionRequest.current || busy) return;
    const current = new AbortController();
    actionRequest.current = current;
    setBusy(true);
    setError('');
    try {
      const result = await api<{ channel: ChannelSetupSummary; pairingUrl?: string }>(
        `/api/channel-settings/telegram/${action}`,
        { method: 'POST', body: JSON.stringify(body), signal: current.signal },
      );
      if (current.signal.aborted) return;
      acceptedSetup(result.channel);
      setPairingUrl(result.pairingUrl ?? null);
      setManualId(false);
      setFields({});
      setEditing('telegram');
    } catch (cause) {
      if (!current.signal.aborted) {
        await load();
        if (!current.signal.aborted) setError(errorMessage(cause));
      }
    } finally {
      if (actionRequest.current === current) actionRequest.current = null;
      if (!current.signal.aborted) setBusy(false);
    }
  }
  function resumeTelegram() {
    setError('');
    setManualId(false);
    setEditing('telegram');
    const candidate = telegramSetup?.pairingCandidate;
    const expiry = telegramSetup?.pairingExpiresAt;
    if (
      telegramSetup?.webhookStatus !== 'registration_pending' &&
      candidate &&
      expiry &&
      Date.parse(expiry) > Date.now()
    )
      return;
    void telegramAction('pairing');
  }
  async function disconnect() {
    const provider = removing;
    if (!provider || actionRequest.current || busy) return;
    const current = new AbortController();
    actionRequest.current = current;
    setBusy(true);
    setRemoveError('');
    try {
      const result = await api<{ channel: ChannelSetupSummary }>(
        `/api/channel-settings/${provider}`,
        {
          method: 'DELETE',
          signal: AbortSignal.any([current.signal, AbortSignal.timeout(15000)]),
        },
      );
      if (current.signal.aborted) return;
      acceptedSetup(result.channel);
      setRemoving(null);
      void load();
    } catch (cause) {
      if (!current.signal.aborted) setRemoveError(errorMessage(cause));
    } finally {
      if (actionRequest.current === current) actionRequest.current = null;
      if (!current.signal.aborted) setBusy(false);
    }
  }
  function cards(items: typeof channels) {
    return (
      <div className="channel-options">
        {items.map(({ provider, setup, configured, connected: isConnected }) => (
          <article
            className={`channel-option${isConnected ? ' is-connected' : ''}${
              !isConnected && 'comingSoon' in provider ? ' is-coming-soon' : ''
            }`}
            key={provider.id}
            aria-labelledby={`channel-${provider.id}`}
          >
            <div className="channel-option-heading">
              <img src={`/logos/${provider.id}.svg`} alt="" width={25} height={25} />
              <div>
                <h3 id={`channel-${provider.id}`}>{provider.name}</h3>
                <p className="channel-option-benefit">{provider.description}</p>
              </div>
              {!isConnected && 'comingSoon' in provider ? (
                <span className="channel-coming-soon">Coming soon</span>
              ) : (
                !isConnected && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="channel-connect"
                    aria-label={`Connect ${provider.name}`}
                    data-connect-channel={provider.id}
                    disabled={busy || !settings?.ready}
                    onClick={() => open(provider.id)}
                  >
                    Connect
                  </Button>
                )
              )}
            </div>
            {isConnected && (
              <ChannelAccount
                provider={provider.id}
                setup={setup}
                configured={configured}
                hosted={hosted}
                onDisconnect={(trigger) => {
                  removeTrigger.current = trigger;
                  removeProvider.current = provider.id;
                  setRemoveError('');
                  setRemoving(provider.id);
                }}
                onPair={resumeTelegram}
                busy={busy || !settings?.ready}
              />
            )}
          </article>
        ))}
      </div>
    );
  }
  return (
    <div className="content-page secondary-page channels-page" ref={page}>
      <header className="page-heading secondary-heading">
        <div>
          <PageTitle path="/channels" />
          <p>Chat with Otto in the apps you use.</p>
        </div>
      </header>
      {(error || loadError) && !editing && <Notice>{error || loadError}</Notice>}
      {data?.error && <Notice>{data.error}</Notice>}
      {settings && !settings.ready && (
        <Notice>
          {hosted
            ? 'Channel setup is temporarily unavailable.'
            : 'The secure key store needs local setup before you can save a channel.'}
        </Notice>
      )}
      {!data || !settings ? (
        loading ? (
          <Loading label="Checking channels…" />
        ) : null
      ) : (
        <>
          {connected.length > 0 && (
            <section className="channels-group" aria-labelledby="channels-connected">
              <h2 id="channels-connected">Connected channels</h2>
              {cards(connected)}
            </section>
          )}
          {available.length > 0 && (
            <section className="channels-group" aria-labelledby="channels-available">
              <h2 id="channels-available">
                {connected.length ? 'More channels' : 'Available channels'}
              </h2>
              {cards(available)}
            </section>
          )}
        </>
      )}
      <Dialog
        open={Boolean(removing)}
        onOpenChange={(value) => {
          if (!value && !busy) setRemoving(null);
        }}
      >
        <DialogContent
          className="channel-remove-dialog"
          aria-busy={busy}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            document.querySelector<HTMLButtonElement>('[data-keep-channel]')?.focus();
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            const trigger = removeTrigger.current;
            if (trigger?.isConnected) trigger.focus();
            else
              (
                page.current?.querySelector<HTMLButtonElement>(
                  `[data-connect-channel="${removeProvider.current}"]`,
                ) ?? document.querySelector<HTMLElement>('#workspace')
              )?.focus();
          }}
        >
          <DialogTitle>
            Remove {removing === 'whatsapp' ? 'WhatsApp' : 'Telegram'} channel?
          </DialogTitle>
          <DialogDescription>
            Otto will stop receiving messages here. You will need its credentials to connect again.
          </DialogDescription>
          {removeError && <Notice>{removeError}</Notice>}
          <div className="channel-remove-actions">
            <Button
              data-keep-channel
              variant="outline"
              disabled={busy}
              onClick={() => setRemoving(null)}
            >
              Keep channel
            </Button>
            <Button variant="destructive" disabled={busy} onClick={() => void disconnect()}>
              {busy ? 'Removing…' : 'Remove channel'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog
        open={Boolean(editing)}
        onOpenChange={(value) => {
          if (!value && !busy) close();
        }}
      >
        <DialogContent className="channel-wizard">
          {editing === 'telegram' ? (
            <>
              <div className="channel-wizard-heading">
                <img src="/logos/telegram.svg" alt="" width={25} height={25} />
                <span>Telegram</span>
              </div>
              <TelegramSetup
                setup={telegramSetup}
                pairingUrl={pairingUrl}
                manual={manualId}
                fields={fields}
                busy={busy}
                error={error || loadError}
                hosted={hosted}
                onField={(name, value) => setFields((current) => ({ ...current, [name]: value }))}
                onVerify={(event) => void submit(event)}
                onClose={close}
                onConfirm={() => void telegramAction('confirm')}
                onNewLink={() => void telegramAction('pairing')}
                onManual={(value) => {
                  setError('');
                  setManualId(value);
                }}
                onSaveId={(event) => {
                  event.preventDefault();
                  void telegramAction('user', { allowedUserId: fields.allowedUserId?.trim() });
                }}
              />
            </>
          ) : (
            <>
              <div className="channel-wizard-heading">
                <img src="/logos/whatsapp.svg" alt="" width={25} height={25} />
                <span>WhatsApp</span>
                <small>
                  Step {step + 1} of {whatsappSteps.length}
                </small>
              </div>
              <DialogTitle>{whatsappSteps[step]}</DialogTitle>
              <DialogDescription className="channel-wizard-description">
                {step === 0
                  ? 'Connect in a few small steps. Otto checks your credentials before saving.'
                  : 'Credentials stay in this secure form, outside the conversation.'}
              </DialogDescription>
              {error && <Notice>{error}</Notice>}
              <form onSubmit={(event) => void submit(event)}>
                <div className="channel-wizard-step" key={`${editing}:${step}`}>
                  <ChannelSetupStep
                    provider="whatsapp"
                    step={step}
                    fields={fields}
                    onField={(name, value) =>
                      setFields((current) => ({ ...current, [name]: value }))
                    }
                    policy={policy}
                    onPolicy={setPolicy}
                    hosted={hosted}
                  />
                </div>
                <div className="channel-wizard-actions">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() => (step ? setStep((value) => value - 1) : close())}
                  >
                    {step ? <ArrowLeft size={14} /> : null}
                    {step ? 'Back' : 'Cancel'}
                  </Button>
                  <Button type="submit" disabled={busy}>
                    {busy
                      ? 'Verifying…'
                      : step === whatsappSteps.length - 1
                        ? 'Verify and save'
                        : 'Continue'}
                    {!busy && step < whatsappSteps.length - 1 && <ArrowRight size={14} />}
                  </Button>
                </div>
              </form>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
