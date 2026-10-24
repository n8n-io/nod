import { PageTitle } from '../components/page-title';
import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, ExternalLink, X } from '../components/icons';
import { TelegramSetup } from '../components/telegram-setup';
import { WhatsAppSetup } from '../components/whatsapp-setup';
import type { ChannelProvider, ChannelSetupSummary } from '../../shared/contracts';
import { telegramState, useChannelSettings } from '../hooks/use-channel-settings';
import { channelLabel, channelSetupBody, telegramBotUrl } from '../lib/secondary-pages';
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
    description: 'Chat with nod in Telegram.',
  },
  {
    id: 'whatsapp' as const,
    name: 'WhatsApp',
    description: 'Chat with nod in WhatsApp.',
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
        this route; keep the rest of nod private.
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
  onDisconnect,
  onPair,
}: {
  provider: (typeof providers)[number];
  setup?: ChannelSetupSummary;
  configured: boolean;
  connected: boolean;
  busy: boolean;
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
    ((provider.id === 'telegram' && (!setup.allowedUserId || setup.pairingExpiresAt)) ||
      (setup.mode === 'linked' && setup.connectionState !== 'connected')),
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
                    ? 'Restart nod to retry the saved setup.'
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
    if (!editing || busy || !settings?.ready) return;
    if (editing === 'whatsapp' && whatsappCloud && step < whatsappSteps.length - 1) {
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
    if (busy || !settings?.ready) return;
    if (!(await telegramRequest(action, body))) return;
    setManualId(false);
    setFields({});
    setEditing('telegram');
  }
  async function resumeTelegram() {
    if (busy || resuming) return;
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
            busy={busy || resuming || !settings?.ready}
            onConnect={() => open(channel.provider.id)}
            onDisconnect={(trigger) => {
              removeTrigger.current = trigger;
              removeProvider.current = channel.provider.id;
              setRemoveError('');
              setRemoving(channel.provider.id);
            }}
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
            nod will stop receiving messages here. You will need its credentials to connect again.
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
          if (!value && !busy && !resuming) close();
        }}
      >
        <DialogContent className="channel-wizard">
          {editing === 'telegram' ? (
            <>
              <div className="channel-wizard-heading">
                <img src="/logos/telegram.svg" alt="" width={24} height={24} />
                <span>Telegram</span>
              </div>
              <DialogTitle>
                {telegramStatus.paired ? 'Telegram is connected' : 'Connect Telegram'}
              </DialogTitle>
              <DialogDescription>
                {telegramStatus.paired
                  ? 'Send your bot a message to start.'
                  : 'Create a bot, then link your Telegram account.'}
              </DialogDescription>
              <TelegramSetup
                setup={telegramSetup}
                pairingUrl={pairingUrl}
                manual={manualId}
                fields={fields}
                busy={busy || resuming}
                error={error || loadError}
                unavailable={!settings?.ready}
                allowWebhook
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
                <Button variant="ghost" size="sm" disabled={busy || resuming} onClick={close}>
                  {telegramStatus.paired ? 'Done' : 'Close'}
                </Button>
                {telegramStatus.paired && telegramUrl && (
                  <Button asChild size="sm">
                    <a
                      data-telegram-primary
                      href={telegramUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      Start conversation
                      <ExternalLink size={16} />
                    </a>
                  </Button>
                )}
              </div>
            </>
          ) : !whatsappCloud ? (
            <>
              <div className="channel-wizard-heading">
                <img src="/logos/whatsapp.svg" alt="" width={24} height={24} />
                <span>WhatsApp</span>
              </div>
              <DialogTitle>Connect WhatsApp</DialogTitle>
              <DialogDescription>
                Link an account with a QR code. nod must be running to answer.
              </DialogDescription>
              <WhatsAppSetup
                setup={channels.find((item) => item.provider.id === 'whatsapp')?.setup}
                busy={busy}
                ready={Boolean(settings?.ready)}
                error={error}
                onSave={async (input) => (await save('whatsapp', input)).ok}
                onRefresh={load}
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
                  ? 'Connect in a few small steps. nod checks your credentials before saving.'
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
