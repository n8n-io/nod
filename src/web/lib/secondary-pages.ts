import type { ChannelProvider, ChannelSetupSummary, Connection } from '../../shared/contracts';

export function connectionGroups(connections: Connection[]) {
  const groups = new Map<string, { service: Connection; accounts: Connection[] }>();
  for (const connection of connections) {
    const group = groups.get(connection.slug) ?? { service: connection, accounts: [] };
    if (connection.connectionId) group.accounts.push(connection);
    groups.set(connection.slug, group);
  }
  return [...groups.values()];
}

export function connectionIssue(connection: Connection) {
  if (connection.browserState === 'disconnecting') return 'Removal needs retry';
  if (connection.browserState === 'pending') return 'Finish sign-in';
  if (connection.browserState === 'needs_sign_in') return 'Sign-in required';
  if (connection.status !== 'connected') return 'Sign-in required';
  return null;
}

export function connectionIdentity(connection: Connection) {
  const name = connection.accountName?.trim();
  const email = connection.accountEmail?.trim();
  return {
    primary: name || email || 'Account details unavailable',
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
  if (setup.webhookStatus === 'registration_pending') return 'Connection needs a retry';
  if (setup.pairingExpiresAt) {
    if (Date.parse(setup.pairingExpiresAt) <= Date.now()) return 'Start link expired';
    return setup.pairingCandidate
      ? 'Confirm your Telegram account'
      : 'Waiting for Start in Telegram';
  }
  if (setup.allowedUserId)
    return `Only ${telegramIdentity(setup.allowedUserId, setup.pairedUser, setup.pairedUsername)} can message Otto`;
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
