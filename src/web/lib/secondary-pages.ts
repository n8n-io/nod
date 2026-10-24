import type { ChannelProvider, ChannelSetupSummary, Connection } from '../../shared/contracts';
import { integrationMetadata } from '../../shared/integrations';

export function connectionGroups(connections: Connection[], catalog: Connection[] = []) {
  const knownServices = new Set(connections.map((connection) => connection.slug));
  const catalogServices = new Map(catalog.map((service) => [service.slug, service]));
  const groups = new Map<string, Connection[]>();
  for (const connection of [
    ...connections.map((connection) => {
      const service = catalogServices.get(connection.slug);
      return connection.connectionId || !service
        ? connection
        : { ...service, ...integrationMetadata(connection.slug, service, connection) };
    }),
    ...catalog.filter((service) => !knownServices.has(service.slug)),
  ]) {
    const key = connection.slug.replace(/_mcp$/, '');
    const group = groups.get(key) ?? [];
    group.push(connection);
    groups.set(key, group);
  }
  return [...groups].map(([key, variants]) => {
    const base = variants.find((connection) => connection.slug === key);
    const configured = variants.filter((connection) => connection.status !== 'not_configured');
    const primary =
      configured.find((connection) => connection.slug === key) ??
      configured[0] ??
      base ??
      variants[0];
    const metadata =
      catalogServices.get(key) ??
      catalogServices.get(primary.slug) ??
      variants.find((connection) => !connection.connectionId);
    const details = integrationMetadata(key, metadata, base, primary, ...variants);
    return {
      key,
      service: {
        ...primary,
        name: details.name.replace(/\s+MCP$/i, ''),
        description: details.description,
        logoUrl:
          metadata?.logoUrl ??
          primary.logoUrl ??
          variants.find((connection) => connection.logoUrl)?.logoUrl,
        categories: [
          ...new Set(
            variants.flatMap(
              (connection) =>
                catalogServices.get(connection.slug)?.categories ?? connection.categories ?? [],
            ),
          ),
        ],
      },
      accounts: variants.filter((connection) => connection.connectionId),
    };
  });
}

export function connectionIssue(connection: Connection) {
  if (connection.browserState === 'disconnecting') return 'Removal needs retry';
  if (connection.browserState === 'pending') return 'Finish sign-in';
  if (connection.browserState === 'needs_sign_in') return 'Sign-in required';
  if (connection.status !== 'connected' || connection.reconnectRequired) return 'Sign-in required';
  return null;
}

export function connectionIdentity(connection: Connection) {
  const name = connection.accountName
    ?.trim()
    .replace(/^(?:\[?redacted\]?|<redacted>|\*{3,})$/i, '');
  const email = connection.accountEmail?.trim();
  return {
    primary: name || email || `${connection.name.replace(/\s+MCP$/i, '')} account`,
    secondary:
      name && email && name.toLocaleLowerCase() !== email.toLocaleLowerCase() ? email : null,
  };
}

export function removeConnection(connections: Connection[], connectionId: string) {
  const removed = connections.find((connection) => connection.connectionId === connectionId);
  const next = connections.filter((connection) => connection.connectionId !== connectionId);
  if (!removed || next.some((connection) => connection.slug === removed.slug)) return next;
  return connections.flatMap((connection) =>
    connection.connectionId !== connectionId
      ? [connection]
      : [
          {
            slug: removed.slug,
            name: removed.name,
            description: removed.description,
            status: 'disconnected' as const,
            triggersEnabled: false,
          },
        ],
  );
}

type ChannelStatus = {
  provider: string;
  status: 'disabled' | 'setup_required' | 'configured';
  missing: string[];
};
export type ChannelResponse = { channels: ChannelStatus[]; error: string | null };
export type ChannelSettings = { ready: boolean; channels: ChannelSetupSummary[] };

export function telegramIdentity(id: string, name?: string, username?: string) {
  return [name, username ? `@${username}` : undefined, `ID ${id}`].filter(Boolean).join(', ');
}

export function channelLabel(setup: ChannelSetupSummary | undefined, configured: boolean) {
  if (!setup?.enabled) return configured ? 'Configuration present' : 'Not connected';
  if (setup.mode === 'linked') {
    const states = {
      connecting: 'Connecting to WhatsApp',
      awaiting_scan: 'Scan the QR code to finish setup',
      connected:
        setup.linkMode === 'self-chat'
          ? 'Chat with nod in Message yourself'
          : 'Only your selected number can message nod',
      disconnected: 'Reconnecting to WhatsApp',
      logged_out: 'Link the WhatsApp account again',
      expired: 'QR setup expired',
      failed: 'Connection needs attention',
    };
    return states[setup.connectionState ?? 'connecting'];
  }
  if (setup.webhookStatus === 'registration_pending') return 'Connection needs a retry';
  if (setup.pairingExpiresAt) {
    if (Date.parse(setup.pairingExpiresAt) <= Date.now()) return 'Start link expired';
    return setup.pairingCandidate
      ? 'Confirm your Telegram account'
      : 'Waiting for Start in Telegram';
  }
  if (setup.allowedUserId)
    return `Only ${telegramIdentity(setup.allowedUserId, setup.pairedUser, setup.pairedUsername)} can message nod`;
  if (setup.mode === 'polling') return null;
  return setup.webhookStatus === 'registered' ? 'Webhook registered' : 'Finish delivery setup';
}

export function telegramBotUrl(handle?: string) {
  return handle && /^@[A-Za-z0-9_]+$/.test(handle) ? `https://t.me/${handle.slice(1)}` : null;
}

export function channelSetupBody(
  provider: ChannelProvider,
  fields: Record<string, string>,
  policyConfirmed: boolean,
) {
  const webhookUrl = fields.webhookUrl?.trim() || undefined;
  if (provider === 'telegram')
    return {
      botToken: fields.botToken?.trim(),
      webhookUrl,
    };
  return {
    accessToken: fields.accessToken?.trim(),
    appSecret: fields.appSecret?.trim(),
    phoneNumberId: fields.phoneNumberId?.trim(),
    allowedNumber: fields.allowedNumber?.trim(),
    verifyToken: fields.verifyToken?.trim(),
    webhookUrl,
    policyConfirmed,
  };
}
