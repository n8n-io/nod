import { PageTitle } from '../components/page-title';
import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Check, ExternalLink, X } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import type { ChannelProvider, ChannelSetupSummary } from '../../shared/contracts';
import { telegramState, useChannelSettings } from '../hooks/use-channel-settings';
import {
  channelLabel,
  channelSetupBody,
  telegramBotUrl,
  telegramIdentity,
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
const channelStatus = {
  connected: 'Connected',
  'needs-setup': 'Needs setup',
  'coming-soon': 'Coming soon',
};
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
      <ExternalLink size={16} />
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
          Telegram and send <code>/newbot</code>. Choose a name and username, then paste BotFather’s
          full reply or just the token here.
        </p>
        <Field
          label="BotFather message or token"
          hint="This stays outside chat and is encrypted when saved."
        >
          <Input
            type="password"
            autoComplete="off"
            required
            autoFocus
            {...field('botToken')}
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
              onField('botToken', input.value);
            }}
          />
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

function ChannelCard({
  provider,
  setup,
  configured,
  connected,
  busy,
  hosted,
  onConnect,
  onDisconnect,
  onPair,
}: {
  provider: (typeof providers)[number];
  setup?: ChannelSetupSummary;
  configured: boolean;
  connected: boolean;
  busy: boolean;
  hosted: boolean;
  onConnect(): void;
  onDisconnect(trigger: HTMLButtonElement): void;
  onPair(): void;
}) {
  const comingSoon = 'comingSoon' in provider;
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
    setup?.enabled &&
    provider.id === 'telegram' &&
    (!setup.allowedUserId || setup.pairingExpiresAt),
  );
  const status: keyof typeof channelStatus | null = connected
    ? needsDelivery || needsPairing
      ? 'needs-setup'
      : 'connected'
    : comingSoon
      ? 'coming-soon'
      : null;
  const statusLabel = channelLabel(setup, configured);
  return (
    <article className="channel-option" aria-labelledby={`channel-${provider.id}`}>
      <img src={`/logos/${provider.id}.svg`} alt="" width={24} height={24} />
      <div className="channel-option-copy">
        <div className="channel-option-title">
          <h3 id={`channel-${provider.id}`}>{provider.name}</h3>
          {status && (
            <span className="channel-chip" data-status={status}>
              {channelStatus[status]}
            </span>
          )}
        </div>
        {connected ? (
          <>
            <p className="channel-account-label">
              {name || handle || 'Saved configuration'}
              {distinctHandle && <span>{handle}</span>}
            </p>
            {statusLabel && <p className="channel-account-status">{statusLabel}</p>}
          </>
        ) : (
          <p className="channel-option-benefit">{provider.description}</p>
        )}
      </div>
      {connected ? (
        <div className="channel-account-actions">
          {provider.id === 'telegram' && (needsDelivery || needsPairing) ? (
            <Button variant="outline" size="sm" disabled={busy} onClick={onPair}>
              {needsDelivery ? 'Retry connection' : 'Finish setup'}
              <ArrowRight size={16} />
            </Button>
          ) : needsDelivery ? (
            <Dialog>
              <DialogTrigger asChild>
                <Button variant="outline" size="sm" disabled={busy}>
                  Finish setup
                  <ArrowRight size={16} />
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogTitle>Finish {provider.name} setup</DialogTitle>
                <DialogDescription>
                  {setup?.webhookStatus === 'registration_pending'
                    ? hosted
                      ? 'Delivery setup could not finish. Contact the person who hosts Otto.'
                      : 'Restart Otto to retry the saved setup.'
                    : 'Finish the callback in Meta and subscribe to messages.'}
                </DialogDescription>
                {setup?.webhookUrl && (!hosted || provider.id === 'whatsapp') && (
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
                <ExternalLink size={16} />
              </a>
            </Button>
          ) : null}
          <Button
            variant="ghost"
            size="icon"
            className="channel-remove"
            data-channel-remove={provider.id}
            aria-label={`Remove ${provider.name} channel`}
            title="Remove channel"
            disabled={busy}
            onClick={(event) => onDisconnect(event.currentTarget)}
          >
            <X size={16} aria-hidden="true" />
          </Button>
        </div>
      ) : (
        !comingSoon && (
          <Button
            variant="outline"
            size="sm"
            className="channel-connect"
            aria-label={`Connect ${provider.name}`}
            data-connect-channel={provider.id}
            disabled={busy}
            onClick={onConnect}
          >
            Connect
          </Button>
        )
      )}
    </article>
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
  const state = telegramState(setup);
  const { saved, needsDelivery, ready, paired, expired } = state;
  const candidate = manual ? undefined : state.candidate;
  const botUrl = telegramBotUrl(setup?.accountHandle);
  const identity =
    paired && setup?.allowedUserId
      ? telegramIdentity(setup.allowedUserId, setup.pairedUser, setup.pairedUsername)
      : '';
  return (
    <>
      <DialogTitle>{paired ? 'Telegram is connected' : 'Connect Telegram'}</DialogTitle>
      <DialogDescription>
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
            {saved ? <Check size={16} /> : '1'}
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
              <Check size={16} />
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
                    <figcaption>
                      Scan this code or use Open Telegram below, then press Start. Use this setup
                      link, not the bot link from BotFather.
                    </figcaption>
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
                          Open Telegram
                          <ExternalLink size={16} />
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
              <ExternalLink size={16} />
            </a>
          </Button>
        )}
      </div>
    </>
  );
}

export function Channels({ hosted = false }: { hosted?: boolean } = {}) {
  const [editing, setEditing] = useState<ChannelProvider | null>(null);
  const {
    data,
    settings,
    error,
    setError,
    loadError,
    loading,
    busy,
    pairingUrl,
    setPairingUrl,
    save,
    telegramAction: telegramRequest,
    remove,
  } = useChannelSettings({ watchTelegram: editing === 'telegram' });
  const [step, setStep] = useState(0);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [policy, setPolicy] = useState(false);
  const [manualId, setManualId] = useState(false);
  const [removing, setRemoving] = useState<ChannelProvider | null>(null);
  const [removeError, setRemoveError] = useState('');
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
  const telegramWaiting = editing === 'telegram' && telegramState(telegramSetup).waiting;
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
  useEffect(() => {
    if (telegramStage)
      document.querySelector<HTMLElement>('[role="dialog"] [data-telegram-primary]')?.focus();
  }, [telegramStage]);
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
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!editing || busy) return;
    if (editing === 'whatsapp' && step < whatsappSteps.length - 1) {
      setStep((value) => value + 1);
      return;
    }
    const provider = editing;
    const result = await save(provider, channelSetupBody(provider, fields, policy));
    if (provider === 'telegram') {
      if (result.ok || result.channel?.enabled) setFields({});
    } else if (result.ok) close();
  }
  async function telegramAction(action: 'pairing' | 'confirm' | 'user', body: object = {}) {
    if (!(await telegramRequest(action, body))) return;
    setManualId(false);
    setFields({});
    setEditing('telegram');
  }
  function resumeTelegram() {
    setError('');
    setManualId(false);
    setEditing('telegram');
    const state = telegramState(telegramSetup);
    if (!state.candidate || !state.waiting) void telegramAction('pairing');
  }
  async function disconnect() {
    const provider = removing;
    if (!provider || busy) return;
    setRemoveError('');
    const failure = await remove(provider);
    if (failure === '') setRemoving(null);
    else if (failure) setRemoveError(failure);
  }
  function cards(items: typeof channels) {
    return (
      <div className="channel-options">
        {items.map((channel) => (
          <ChannelCard
            key={channel.provider.id}
            {...channel}
            hosted={hosted}
            busy={busy || !settings?.ready}
            onConnect={() => open(channel.provider.id)}
            onDisconnect={(trigger) => {
              removeTrigger.current = trigger;
              removeProvider.current = channel.provider.id;
              setRemoveError('');
              setRemoving(channel.provider.id);
            }}
            onPair={resumeTelegram}
          />
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
                <img src="/logos/telegram.svg" alt="" width={24} height={24} />
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
                <img src="/logos/whatsapp.svg" alt="" width={24} height={24} />
                <span>WhatsApp</span>
                <small>
                  Step {step + 1} of {whatsappSteps.length}
                </small>
              </div>
              <DialogTitle>{whatsappSteps[step]}</DialogTitle>
              <DialogDescription>
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
                    {step ? <ArrowLeft size={16} /> : null}
                    {step ? 'Back' : 'Cancel'}
                  </Button>
                  <Button type="submit" disabled={busy}>
                    {busy
                      ? 'Verifying…'
                      : step === whatsappSteps.length - 1
                        ? 'Verify and save'
                        : 'Continue'}
                    {!busy && step < whatsappSteps.length - 1 && <ArrowRight size={16} />}
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
