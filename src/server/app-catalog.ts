import { readFileSync, readdirSync, realpathSync, statSync, existsSync } from 'node:fs';
import { isIP } from 'node:net';
import { resolve, sep, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Compile } from 'typebox/compile';
import {
  appDefinitionSchema,
  appContractSchema,
  appExtensionSchema,
  type AppContract,
  type AppDefinition,
  type AppOAuthMetadata,
} from '../shared/app-definitions.ts';
import { appRequestUrl } from './app-requests.ts';
import { appAccessSchema } from './app-access.ts';
import pluginSchema from './agent-plugins/plugin.schema.json' with { type: 'json' };
import mcpSchema from './agent-plugins/mcp.schema.json' with { type: 'json' };

const manifestCheck = Compile(pluginSchema as Parameters<typeof Compile>[0]);
const mcpCheck = Compile(mcpSchema as Parameters<typeof Compile>[0]);
type AppMetadata = {
  slug: string;
  name: string;
  description: string;
  categories: string[];
  endpoint?: string;
  instancePath?: string;
  hints?: Record<string, string>;
  scope?: string;
  icon?: { bytes: Uint8Array; mimeType: string };
  skills?: string;
};
export type BundledApp = AppMetadata &
  (
    | {
        kind: 'mcp';
        auth: 'oauth' | 'bearer' | 'x-api-key';
        contract: Extract<AppContract, { type: 'mcp' }>;
      }
    | {
        kind: 'http';
        endpoint: string;
        auth: 'oauth' | 'bearer' | 'x-api-key';
        apiKeyHeader?: string;
        oauth?: AppOAuthMetadata;
        clientIdRequired?: boolean;
        contract: Extract<AppContract, { type: 'http' }>;
      }
    | {
        kind: 'cli';
        auth: 'env';
        command: string;
        source: Extract<AppDefinition['connection'], { type: 'cli' }>['source'];
        environment: Record<string, string>;
        contract: Extract<AppContract, { type: 'cli' }>;
      }
  );

function publicAddress(value: string, name: string, query = false) {
  const url = URL.parse(value);
  if (
    !url ||
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    (url.port !== '' && url.port !== '80' && url.port !== '443') ||
    (query ? /#/.test(value) : /[?#]/.test(value)) ||
    isIP(url.hostname.replace(/^\[|\]$/g, '')) ||
    /(?:^|\.)(?:localhost|local|internal|invalid|test|example|example\.(?:com|org|net))$/.test(
      url.hostname.replace(/\.$/, ''),
    )
  )
    throw new Error(
      `App ${name}: use a fixed public HTTPS address without credentials, a query, or a fragment.`,
    );
  return url.href;
}

export function loadAppCatalog(directory = fileURLToPath(new URL('../apps/', import.meta.url))) {
  const root = realpathSync(directory);
  const result = new Map<string, BundledApp>();
  for (const entry of readdirSync(root, { withFileTypes: true })
    .filter((item) => !item.name.startsWith('.'))
    .sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory())
      throw new Error(`App ${entry.name}: use one directory per app without symbolic links.`);
    const base = realpathSync(resolve(root, entry.name));
    if (!base.startsWith(root + sep))
      throw new Error(`App ${entry.name}: the directory leaves the app catalog.`);
    function file(path: string) {
      const target = realpathSync(resolve(base, path));
      if (!target.startsWith(base + sep))
        throw new Error(`App ${entry.name}: ${path} leaves the app directory.`);
      if (!statSync(target).isFile())
        throw new Error(`App ${entry.name}: ${path} must be a regular file.`);
      return target;
    }
    function json(path: string) {
      try {
        return JSON.parse(readFileSync(file(path), 'utf8'));
      } catch (cause) {
        const reason =
          cause instanceof SyntaxError
            ? `invalid JSON${/position \d+/.exec(cause.message)?.[0] ? ` at ${/position \d+/.exec(cause.message)![0]}` : ''}`
            : cause instanceof Error
              ? cause.message
              : 'unknown file error';
        throw new Error(`App ${entry.name}: could not read ${path}: ${reason}`);
      }
    }
    const rawManifest = json('plugin.json');
    if (!manifestCheck.Check(rawManifest))
      throw new Error(
        `App ${entry.name}: plugin.json does not match Agent Plugins 1.0.0: ${manifestCheck
          .Errors(rawManifest)
          .slice(0, 3)
          .map((error) => `${error.instancePath || '/'} ${error.message}`)
          .join('; ')}`,
      );
    const manifest = rawManifest as {
      name: string;
      version?: string;
      description?: string;
      extensions?: Record<string, unknown>;
      author?: { name?: string };
    };
    if (
      manifest.name !== entry.name ||
      !/^[a-z][a-z0-9-]{0,38}[a-z0-9]$/.test(manifest.name) ||
      /--/.test(manifest.name)
    )
      throw new Error(
        `App ${entry.name}: name must match its folder and use two to 40 lowercase letters, digits, or single hyphens. Start with a letter and end with a letter or digit.`,
      );
    if (
      typeof manifest.version !== 'string' ||
      !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*)?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/.test(
        manifest.version,
      )
    )
      throw new Error(`App ${entry.name}: set a semantic version in plugin.json.`);
    if (
      typeof manifest.description !== 'string' ||
      !manifest.description.trim() ||
      manifest.description.length > 1000
    )
      throw new Error(`App ${entry.name}: add a description of up to 1,000 characters.`);
    const extension = appExtensionSchema.safeParse(manifest.extensions?.['io.n8n.nod']);
    if (!extension.success)
      throw new Error(
        `App ${entry.name}: invalid io.n8n.nod reference: ${extension.error.message}`,
      );
    const parsed = appDefinitionSchema.safeParse(json('io.n8n.nod/app.json'));
    if (!parsed.success)
      throw new Error(`App ${entry.name}: invalid app.json: ${parsed.error.message}`);
    const app = parsed.data;
    const contract = appContractSchema.safeParse(json('io.n8n.nod/contract.json'));
    if (!contract.success)
      throw new Error(`App ${entry.name}: invalid contract.json: ${contract.error.message}`);
    if (
      !manifest.author?.name?.trim() ||
      /Replace with|replace[_-]with[_-]/.test(
        JSON.stringify({ manifest, app, contract: contract.data }),
      )
    )
      throw new Error(
        `App ${entry.name}: complete the maintainer, provider documentation, requirements, and limits.`,
      );
    const connection = app.connection;
    const fixture = contract.data;
    const hints = 'hints' in connection ? connection.hints : undefined;
    const unknownHint =
      connection.type === 'cli' &&
      Object.keys(hints ?? {}).find((name) => !(name in connection.environment));
    if (unknownHint)
      throw new Error(`App ${entry.name}: hint ${unknownHint} names no environment field.`);
    if (fixture.type !== connection.type)
      throw new Error(`App ${entry.name}: the read fixture must use the app connection type.`);
    const setup = (() => {
      if (connection.type === 'cli' && fixture.type === 'cli') {
        if (existsSync(resolve(base, 'mcp.json')))
          throw new Error(`App ${entry.name}: only MCP apps can include mcp.json.`);
        if ('url' in connection.source) publicAddress(connection.source.url, entry.name);
        return {
          kind: 'cli' as const,
          auth: 'env' as const,
          command: connection.command,
          source: connection.source,
          environment: connection.environment,
          contract: fixture,
        };
      }
      if (connection.type === 'http' && fixture.type === 'http') {
        if (existsSync(resolve(base, 'mcp.json')))
          throw new Error(`App ${entry.name}: only MCP apps can include mcp.json.`);
        const endpoint = publicAddress(connection.url, entry.name);
        const apiKeyHeader = 'apiKeyHeader' in connection ? connection.apiKeyHeader : undefined;
        const oauth = 'oauth' in connection ? connection.oauth : undefined;
        if (oauth) {
          publicAddress(oauth.issuer, entry.name);
          for (const url of [
            oauth.authorization_endpoint,
            oauth.token_endpoint,
            oauth.registration_endpoint,
          ].filter((value): value is string => Boolean(value))) {
            publicAddress(url, entry.name, true);
            if (new URL(url).port && new URL(url).port !== '443')
              throw new Error(
                `App ${entry.name}: OAuth endpoints must use the standard HTTPS port.`,
              );
          }
          if (
            !oauth.registration_endpoint &&
            !('clientIdRequired' in connection && connection.clientIdRequired)
          )
            throw new Error(
              `App ${entry.name}: require a client ID when the configured OAuth server has no registration endpoint.`,
            );
        }
        appRequestUrl(endpoint, fixture.request.path);
        return {
          kind: 'http' as const,
          endpoint,
          auth:
            connection.authentication[0] === 'oauth2'
              ? ('oauth' as const)
              : connection.authentication[0],
          ...(apiKeyHeader ? { apiKeyHeader } : {}),
          ...(oauth ? { oauth } : {}),
          ...('clientIdRequired' in connection && connection.clientIdRequired
            ? { clientIdRequired: true }
            : {}),
          ...('scopes' in connection && connection.scopes?.length
            ? { scope: connection.scopes.join(' ') }
            : {}),
          contract: fixture,
        };
      }
      if (connection.type !== 'mcp' || fixture.type !== 'mcp')
        throw new Error(`App ${entry.name}: invalid connection and read fixture.`);
      const instance = 'endpoint' in connection;
      const scopes = 'scopes' in connection ? connection.scopes : undefined;
      let endpoint: string | undefined;
      if (existsSync(resolve(base, 'mcp.json'))) {
        const rawMcp = json('mcp.json');
        if (!mcpCheck.Check(rawMcp))
          throw new Error(
            `App ${entry.name}: mcp.json does not match Agent Plugins 1.0.0: ${mcpCheck
              .Errors(rawMcp)
              .slice(0, 3)
              .map((error) => `${error.instancePath || '/'} ${error.message}`)
              .join('; ')}`,
          );
        const mcp = rawMcp as {
          mcpServers: Record<
            string,
            { type: string; url: string; headers?: Record<string, string> }
          >;
        };
        if (instance || Object.keys(mcp.mcpServers).length !== 1)
          throw new Error(
            `App ${entry.name}: fixed apps need one MCP server; owner-supplied endpoints must omit mcp.json.`,
          );
        const server = !instance ? connection.server : '';
        const selected = Object.hasOwn(mcp.mcpServers, server) ? mcp.mcpServers[server] : undefined;
        if (!selected)
          throw new Error(`App ${entry.name}: mcp.json has no server named ${server}.`);
        if (selected.type !== 'streamable-http')
          throw new Error(`App ${entry.name}: the selected server must use streamable-http.`);
        endpoint = publicAddress(selected.url, entry.name);
        if (Object.keys(selected.headers ?? {}).length)
          throw new Error(
            `App ${entry.name}: fixed MCP headers are not supported. Use private connection setup for credentials.`,
          );
      } else if (!instance)
        throw new Error(`App ${entry.name}: add mcp.json for the selected server.`);
      return {
        kind: 'mcp' as const,
        auth:
          connection.authentication[0] === 'oauth2'
            ? ('oauth' as const)
            : connection.authentication[0],
        ...(endpoint ? { endpoint } : {}),
        ...(instance ? { instancePath: connection.endpoint.path } : {}),
        ...(scopes?.length ? { scope: scopes.join(' ') } : {}),
        contract: fixture,
      };
    })();
    let icon: BundledApp['icon'];
    if (app.icon) {
      if (!app.icon.startsWith('./io.n8n.nod/'))
        throw new Error(`App ${entry.name}: keep the icon in ./io.n8n.nod/.`);
      const mimeType = { '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp' }[
        extname(app.icon)
      ];
      const bytes = readFileSync(file(app.icon));
      if (!mimeType || bytes.length === 0 || bytes.length > 128 * 1024)
        throw new Error(`App ${entry.name}: use an SVG, PNG, or WebP icon of up to 128 KB.`);
      icon = { bytes, mimeType };
    }
    let skills: string | undefined;
    if (existsSync(resolve(base, 'skills'))) {
      skills = realpathSync(resolve(base, 'skills'));
      if (!skills.startsWith(base + sep) || !statSync(skills).isDirectory())
        throw new Error(`App ${entry.name}: skills must be a directory inside the app.`);
    }
    const definition: BundledApp = {
      ...setup,
      slug: manifest.name,
      name: app.displayName,
      description: manifest.description.trim(),
      categories: app.categories,
      ...(hints ? { hints } : {}),
      ...(icon ? { icon } : {}),
      ...(skills ? { skills } : {}),
    };
    if (!definition.instancePath) {
      const access = appAccessSchema.safeParse(appAccessPath(definition));
      if (!access.success)
        throw new Error(`App ${entry.name}: invalid connection: ${access.error.message}`);
    }
    result.set(manifest.name, definition);
  }
  return result;
}

export const bundledApps = loadAppCatalog();

export function appAccessPath(app: BundledApp) {
  if (app.kind === 'cli')
    return {
      kind: 'cli' as const,
      command: app.command,
      auth: 'env' as const,
      env: Object.keys(app.environment),
      source: app.source,
      testArgv: app.contract.argv,
      testTimeoutSeconds: app.contract.timeoutSeconds,
      testFormat: app.contract.format,
    };
  if (app.kind === 'http')
    return {
      kind: 'http' as const,
      endpoint: app.endpoint,
      auth: app.auth,
      testPath: app.contract.request.path,
      testMethod: app.contract.request.method,
      ...(app.contract.request.method === 'POST' ? { testBody: app.contract.request.body } : {}),
      ...(app.apiKeyHeader ? { apiKeyHeader: app.apiKeyHeader } : {}),
      ...(app.oauth ? { oauth: app.oauth } : {}),
      ...(app.scope ? { scope: app.scope } : {}),
      ...(app.clientIdRequired ? { clientIdRequired: true } : {}),
    };
  if (!app.endpoint)
    throw new Error(`App ${app.slug}: enter the instance address before connecting.`);
  return {
    kind: 'mcp' as const,
    endpoint: app.endpoint,
    auth: app.auth,
    ...(app.scope ? { scope: app.scope } : {}),
  };
}
