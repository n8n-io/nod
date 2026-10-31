import { PageTitle } from '../components/page-title';
import { useEffect, useId, useRef, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import {
  ArrowLeft,
  ArrowRight,
  Bot,
  CircleCheck,
  ExternalLink,
  Settings,
  Unlink,
  UserRound,
} from '../components/icons';
import { IntegrationCard } from '../components/integration-card';
import { TelegramSetup } from '../components/telegram-setup';
import { WhatsAppSetup } from '../components/whatsapp-setup';
import type { ChannelProvider, ChannelSetupSummary } from '../../shared/contracts';
import { telegramState, useChannelSettings } from '../hooks/use-channel-settings';
import { channelSetupBody, telegramBotUrl } from '../lib/secondary-pages';
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
    description: 'Chat with Nod in Telegram.',
  },
  {
    id: 'whatsapp' as const,
    name: 'WhatsApp',
    description: 'Chat with Nod in WhatsApp.',
  },
];
const channelStatus = {
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

function TelegramChat({ url }: { url: string }) {
  const [phone, setPhone] = useState(false);
  const id = useId();
  return (
    <section className="channel-chat" aria-labelledby={`${id}-title`}>
      <h3 id={`${id}-title`}>Chat from Telegram</h3>
      <div className="channel-chat-actions">
        <Button asChild>
          <a href={url} target="_blank" rel="noopener noreferrer">
            Open on this computer
            <ExternalLink size={16} aria-hidden="true" />
          </a>
        </Button>
        <Button
          variant="outline"
          aria-expanded={phone}
          aria-controls={`${id}-phone`}
          onClick={() => setPhone((value) => !value)}
        >
          Scan on phone
        </Button>
      </div>
      <div className="channel-chat-phone" id={`${id}-phone`} hidden={!phone}>
        <div className="channel-chat-qr" data-analytics-private>
          <QRCodeSVG
            value={url}
            size={160}
            marginSize={4}
            level="M"
            role="img"
            title="Open your Telegram bot on your phone"
          />
        </div>
        <p>Scan with your phone camera to open this bot in Telegram.</p>
      </div>
    </section>
  );
}

function ChannelSetupStep({
  step,
  fields,
  onField,
  policy,
  onPolicy,
}: {
  step: number;
  fields: Record<string, string>;
  onField(name: string, value: string): void;
  policy: boolean;
  onPolicy(value: boolean): void;
}) {
  const field = (name: string) => ({
    value: fields[name] ?? '',
    onChange: (event: React.ChangeEvent<HTMLInputElement>) => onField(name, event.target.value),
  });
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
          <li>A public HTTPS callback for messages</li>
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
        Use these same callback settings in Meta, then subscribe the app to messages. Expose only
        this route; keep the rest of Nod private.
      </p>
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
  onConnect,
  onPair,
}: {
  provider: (typeof providers)[number];
  setup?: ChannelSetupSummary;
  configured: boolean;
  connected: boolean;
  busy: boolean;
  onConnect(): void;
  onPair(): void;
}) {
  const comingSoon = 'comingSoon' in provider;
  const needsDelivery = Boolean(
    setup?.enabled &&
    (setup.webhookStatus === 'registration_pending' ||
      (setup.mode === 'webhook' && setup.webhookStatus !== 'registered')),
  );
  const needsPairing = Boolean(
    setup?.enabled &&
    ((provider.id === 'telegram' && (!setup.allowedUserId || setup.pairingExpiresAt)) ||
      (setup.mode === 'linked' && setup.connectionState !== 'connected')),
  );
  const status: keyof typeof channelStatus | null = connected
    ? needsDelivery || needsPairing || !configured
      ? 'needs-setup'
      : null
    : comingSoon
      ? 'coming-soon'
      : null;
  return (
    <IntegrationCard
      id={`channel-${provider.id}`}
      className="channel-option"
      name={provider.name}
      logo={<img src={`/logos/${provider.id}.svg`} alt="" width={24} height={24} />}
      description={provider.description}
      detail={setup?.managed ? 'Managed by your server' : undefined}
      badge={
        status && (
          <span className="channel-chip" data-status={status}>
            {channelStatus[status]}
          </span>
        )
      }
      actions={
        setup?.managed ? (
          setup.enabled && configured && setup.mode === 'linked' && needsPairing ? (
            <Button variant="outline" size="sm" disabled={busy} onClick={onPair}>
              Link WhatsApp
              <ArrowRight size={16} />
            </Button>
          ) : null
        ) : connected ? (
          <div className="channel-account-actions">
            {(provider.id === 'telegram' && needsDelivery) || needsPairing ? (
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
                      ? 'Restart Nod to retry the saved setup.'
                      : 'Finish the callback in Meta and subscribe to messages.'}
                  </DialogDescription>
                  {setup?.webhookUrl && (
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
            ) : null}
            <Button
              variant="ghost"
              size="icon"
              data-manage-channel={provider.id}
              title={`Manage ${provider.name}`}
              aria-label={`Manage ${provider.name}`}
              disabled={busy}
              onClick={onConnect}
            >
              <Settings size={16} aria-hidden="true" />
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
        )
      }
    />
  );
}

export function Channels() {
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
    load,
    save,
    telegramAction: telegramRequest,
    remove,
  } = useChannelSettings({
    watchTelegram: editing === 'telegram',
    watchWhatsApp: editing === 'whatsapp',
  });
  const [step, setStep] = useState(0);
  const [fields, setFields] = useState<Record<string, string>>({});
  const whatsappCloud = fields.connection === 'cloud';
  const [policy, setPolicy] = useState(false);
  const [manualId, setManualId] = useState(false);
  const [resuming, setResuming] = useState(false);
  const [removing, setRemoving] = useState<ChannelProvider | null>(null);
  const [removeError, setRemoveError] = useState('');
  const page = useRef<HTMLDivElement>(null);
  const removeTrigger = useRef<HTMLButtonElement | null>(null);
  const setupTrigger = useRef<HTMLButtonElement | null>(null);
  const manageTitle = useRef<HTMLHeadingElement>(null);
  const removeProvider = useRef<ChannelProvider | null>(null);
  const channels = providers.map((provider) => {
    const setup = settings?.channels.find((item) => item.provider === provider.id);
    const configured = Boolean(
      data?.channels.some((item) => item.provider === provider.id && item.status === 'configured'),
    );
    return { provider, setup, configured, connected: Boolean(setup?.enabled || configured) };
  });
  const telegramSetup = channels[0].setup;
  const telegramStatus = telegramState(telegramSetup);
  const telegramUrl = telegramBotUrl(telegramSetup?.accountHandle);
  const telegramWaiting = editing === 'telegram' && telegramStatus.waiting;
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
      document
        .querySelector<HTMLElement>('[role="dialog"] [data-telegram-primary]')
        ?.focus({ preventScroll: true });
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
    setupTrigger.current =
      document.activeElement instanceof HTMLButtonElement ? document.activeElement : null;
    setFields({});
    setPolicy(false);
    setError('');
    setStep(0);
    setEditing(provider);
  }
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!editing || busy || !settings?.ready) return;
    if (editing === 'whatsapp' && whatsappCloud && step < whatsappSteps.length - 1) {
      setStep((value) => value + 1);
      return;
    }
    const provider = editing;
    const result = await save(provider, channelSetupBody(provider, fields, policy));
    if (provider === 'telegram') {
      if (result.ok && telegramState(result.channel).paired) close();
      else if (result.ok || result.channel?.enabled) setFields({});
    } else if (result.ok) close();
  }
  async function telegramAction(action: 'pairing' | 'confirm' | 'user', body: object = {}) {
    if (busy || !settings?.ready) return;
    if (!(await telegramRequest(action, body))) return;
    if (action !== 'pairing') {
      close();
      return;
    }
    setManualId(false);
    setFields({});
    setEditing('telegram');
  }
  async function resumeTelegram() {
    if (busy || resuming) return;
    setupTrigger.current =
      document.activeElement instanceof HTMLButtonElement ? document.activeElement : null;
    setError('');
    setManualId(false);
    setEditing('telegram');
    setResuming(true);
    try {
      const latest = await load();
      if (!latest?.ready) return;
      const state = telegramState(
        latest.channels.find((channel) => channel.provider === 'telegram'),
      );
      if (state.saved && !state.paired && (!state.candidate || !state.waiting))
        await telegramAction('pairing');
    } finally {
      setResuming(false);
    }
  }
  async function disconnect() {
    const provider = removing;
    if (!provider || busy) return;
    setRemoveError('');
    const failure = await remove(provider);
    if (failure === '') {
      setRemoving(null);
      close();
    } else if (failure) setRemoveError(failure);
  }
  function confirmDisconnect(provider: ChannelProvider) {
    removeTrigger.current =
      document.activeElement instanceof HTMLButtonElement ? document.activeElement : null;
    removeProvider.current = provider;
    setRemoveError('');
    setRemoving(provider);
  }
  const selected = channels.find((channel) => channel.provider.id === editing);
  const managing = Boolean(
    selected?.setup?.enabled &&
    !whatsappCloud &&
    (editing === 'telegram' ? telegramStatus.paired : selected.setup.mode !== 'linked'),
  );
  function cards(items: typeof channels) {
    return (
      <div className="channel-options">
        {items.map((channel) => (
          <ChannelCard
            key={channel.provider.id}
            {...channel}
            busy={busy || resuming || !settings?.ready}
            onConnect={() => open(channel.provider.id)}
            onPair={() =>
              channel.provider.id === 'whatsapp' ? open('whatsapp') : void resumeTelegram()
            }
          />
        ))}
      </div>
    );
  }
  return (
    <div className="content-page secondary-page channels-page" ref={page}>
      <header className="page-heading secondary-heading">
        <PageTitle path="/channels" />
      </header>
      {(error || loadError) && !editing && <Notice>{error || loadError}</Notice>}
      {loadError && !editing && (
        <Button variant="outline" size="sm" disabled={loading || busy} onClick={() => void load()}>
          {loading ? 'Retrying…' : 'Retry loading'}
        </Button>
      )}
      {data?.error && <Notice>{data.error}</Notice>}
      {settings && !settings.ready && (
        <Notice>The secure key store needs local setup before you can save a channel.</Notice>
      )}
      {!data || !settings ? (
        loading ? (
          <Loading label="Checking channels…" />
        ) : null
      ) : (
        <>
          {connected.length > 0 && (
            <section className="channels-group" aria-labelledby="channels-connected">
              <h2 id="channels-connected">Connected</h2>
              {cards(connected)}
            </section>
          )}
          {available.length > 0 && (
            <section className="channels-group" aria-labelledby="channels-available">
              <h2 id="channels-available">{connected.length ? 'More' : 'Available'}</h2>
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
            document
              .querySelector<HTMLButtonElement>('[data-keep-channel]')
              ?.focus({ preventScroll: true });
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            const trigger = removeTrigger.current;
            if (trigger?.isConnected) trigger.focus({ preventScroll: true });
            else
              (
                document.querySelector<HTMLButtonElement>('[data-channel-disconnect]') ??
                page.current?.querySelector<HTMLButtonElement>(
                  `[data-connect-channel="${removeProvider.current}"]`,
                ) ??
                document.querySelector<HTMLElement>('#workspace')
              )?.focus({ preventScroll: true });
          }}
        >
          <DialogTitle>Disconnect {removing === 'whatsapp' ? 'WhatsApp' : 'Telegram'}?</DialogTitle>
          <DialogDescription>
            Nod will stop receiving messages here. You can connect again later.
          </DialogDescription>
          {removeError && <Notice>{removeError}</Notice>}
          <div className="channel-remove-actions">
            <Button
              data-keep-channel
              variant="outline"
              disabled={busy}
              onClick={() => setRemoving(null)}
            >
              Keep connected
            </Button>
            <Button variant="destructive" disabled={busy} onClick={() => void disconnect()}>
              {busy ? 'Disconnecting…' : 'Disconnect'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog
        open={Boolean(editing) && !removing}
        onOpenChange={(value) => {
          if (!value && !busy && !resuming) close();
        }}
      >
        <DialogContent
          className={
            managing ? 'channel-wizard app-manage-dialog channel-manage-dialog' : 'channel-wizard'
          }
          {...(managing ? { 'aria-describedby': undefined } : {})}
          onOpenAutoFocus={(event) => {
            if (!managing) return;
            event.preventDefault();
            manageTitle.current?.focus({ preventScroll: true });
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (removing) return;
            const trigger = setupTrigger.current;
            if (trigger?.isConnected) trigger.focus({ preventScroll: true });
            else
              (
                page.current?.querySelector<HTMLElement>(
                  '[data-manage-channel], [data-connect-channel]',
                ) ?? document.querySelector<HTMLElement>('#workspace')
              )?.focus({ preventScroll: true });
          }}
        >
          {managing ? (
            <>
              <div className="dialog-heading app-manage-heading">
                <img src={`/logos/${editing}.svg`} alt="" width={28} height={28} />
                <DialogTitle ref={manageTitle} tabIndex={-1}>
                  {selected?.provider.name}
                </DialogTitle>
              </div>
              <div className="compact-account" data-analytics-private>
                <span className="app-account-avatar" aria-hidden="true">
                  {editing === 'telegram' ? <Bot size={18} /> : <UserRound size={18} />}
                </span>
                <div className="compact-account-details">
                  <span className="compact-account-name">
                    {selected?.setup?.accountName ||
                      selected?.setup?.accountHandle ||
                      'Your account'}
                  </span>
                  {selected?.setup?.accountName && selected.setup.accountHandle && (
                    <span className="compact-account-email">{selected.setup.accountHandle}</span>
                  )}
                  <span className="app-account-status">
                    <CircleCheck size={12} aria-hidden="true" />
                    Connected
                  </span>
                </div>
                <div className="app-account-actions">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="account-disconnect"
                    data-channel-disconnect
                    aria-label={`Disconnect ${selected?.provider.name}`}
                    title={`Disconnect ${selected?.provider.name}`}
                    disabled={busy}
                    onClick={() => confirmDisconnect(editing!)}
                  >
                    <Unlink size={16} aria-hidden="true" />
                  </Button>
                </div>
              </div>
              {editing === 'telegram' && (
                <div className="channel-authorized-account" data-analytics-private>
                  <span className="app-account-avatar" aria-hidden="true">
                    <UserRound size={18} />
                  </span>
                  <div className="compact-account-details">
                    <span className="channel-identity-label">Allowed account</span>
                    <span className="compact-account-name">
                      {telegramSetup?.pairedUser || 'Your Telegram account'}
                    </span>
                    {telegramSetup?.pairedUsername && (
                      <span className="compact-account-email">
                        @{telegramSetup.pairedUsername.replace(/^@/, '')}
                      </span>
                    )}
                  </div>
                </div>
              )}
              {editing === 'telegram' && telegramUrl ? (
                <TelegramChat key={telegramUrl} url={telegramUrl} />
              ) : editing === 'whatsapp' ? (
                <div className="dialog-actions app-manage-actions">
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() => {
                      setFields({ connection: 'cloud' });
                      setStep(0);
                      setPolicy(false);
                    }}
                  >
                    Update connection
                  </Button>
                </div>
              ) : null}
            </>
          ) : editing === 'telegram' ? (
            <>
              <DialogTitle className="channel-wizard-title">
                <img src="/logos/telegram.svg" alt="" width={24} height={24} />
                {telegramStatus.paired ? 'Telegram' : 'Connect Telegram'}
              </DialogTitle>
              <DialogDescription>Create a bot, then link your account.</DialogDescription>
              <TelegramSetup
                setup={telegramSetup}
                pairingUrl={pairingUrl}
                manual={manualId}
                fields={fields}
                busy={busy || resuming}
                error={error || loadError}
                unavailable={!settings?.ready}
                onField={(name, value) => setFields((current) => ({ ...current, [name]: value }))}
                onVerify={(event) => void submit(event)}
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
              <div className="channel-wizard-actions">
                {telegramSetup?.enabled && (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy || resuming}
                    onClick={() => confirmDisconnect('telegram')}
                  >
                    Disconnect
                  </Button>
                )}
                {loadError && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={loading || busy || resuming}
                    onClick={() => void load()}
                  >
                    {loading ? 'Retrying…' : 'Retry loading'}
                  </Button>
                )}
              </div>
            </>
          ) : !whatsappCloud ? (
            <>
              <DialogTitle className="channel-wizard-title">
                <img src="/logos/whatsapp.svg" alt="" width={24} height={24} />
                {selected?.setup?.connectionState === 'connected' ? 'WhatsApp' : 'Connect WhatsApp'}
              </DialogTitle>
              <DialogDescription>
                {selected?.setup?.connectionState === 'connected'
                  ? 'Keep Nod running to receive messages.'
                  : 'Link an account with a QR code.'}
              </DialogDescription>
              <WhatsAppSetup
                setup={channels.find((item) => item.provider.id === 'whatsapp')?.setup}
                busy={busy}
                ready={Boolean(settings?.ready)}
                error={error}
                onSave={async (input) => (await save('whatsapp', input)).ok}
                onRefresh={load}
                onDisconnect={() => confirmDisconnect('whatsapp')}
                onCloud={() => {
                  setFields({ connection: 'cloud' });
                  setPolicy(false);
                  setStep(0);
                }}
                onDone={close}
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
                  ? 'Connect in a few small steps. Nod checks your credentials before saving.'
                  : 'Credentials stay in this secure form, outside the conversation.'}
              </DialogDescription>
              {error && <Notice>{error}</Notice>}
              <form onSubmit={(event) => void submit(event)}>
                <div className="channel-wizard-step" key={`${editing}:${step}`}>
                  <ChannelSetupStep
                    step={step}
                    fields={fields}
                    onField={(name, value) =>
                      setFields((current) => ({ ...current, [name]: value }))
                    }
                    policy={policy}
                    onPolicy={setPolicy}
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
