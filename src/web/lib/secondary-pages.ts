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
        : {
            ...service,
            ...integrationMetadata(connection.slug, service, connection),
            ...(connection.direct ? { direct: true } : {}),
          };
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
        name: primary.canRename ? primary.name : details.name.replace(/\s+MCP$/i, ''),
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
  if (connection.slug === 'notion_mcp')
    return connection.disconnectPending ? 'Removal needs retry' : 'Connect Notion again';
  if (connection.status !== 'connected' || connection.reconnectRequired) return 'Sign-in required';
  return null;
}

export function connectionIdentity(connection: Connection) {
  const name = connection.accountName
    ?.trim()
    .replace(/^(?:\[?redacted\]?|<redacted>|\*{3,})$/i, '');
  const email = connection.accountEmail?.trim();
  return {
    primary:
      name ||
      email ||
      `${connection.canRename ? connection.name : connection.name.replace(/\s+MCP$/i, '')} account`,
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
  available?: boolean;
  error?: string;
  lastMessageAt?: string | null;
};
export type ChannelResponse = { channels: ChannelStatus[]; error: string | null };
export type ChannelSettings = { ready: boolean; channels: ChannelSetupSummary[] };

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
