import { z } from 'zod';

export const appSchemaId = 'https://nod.n8n.io/docs/schemas/apps/v1/app.schema.json';
export const appContractSchemaId = 'https://nod.n8n.io/docs/schemas/apps/v1/contract.schema.json';

export const appExtensionSchema = z.strictObject({ app: z.literal('./io.n8n.nod/app.json') });

const text = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .regex(/^\S(?:[\s\S]*\S)?$/, 'Remove leading and trailing whitespace.');
const name = (max: number) =>
  text(max).regex(
    /^[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+$/u,
    'Use one line without control or format characters.',
  );
const fixedServer = { type: z.literal('mcp'), server: text(80) };
const hints = <const Field extends string>(...fields: Field[]) =>
  z.partialRecord(z.enum(fields), text(200)).optional();
const controlHeaders = [
  'host',
  'cookie',
  'set-cookie',
  'connection',
  'content-.*',
  'transfer-encoding',
  'proxy-.*',
  'accept',
  'user-agent',
  'upgrade',
  'te',
  'trailer',
]
  .map((name) => name.replace(/[a-z]/g, (letter) => `[${letter}${letter.toUpperCase()}]`))
  .join('|');
export const appApiKeyHeaderSchema = z
  .string()
  .max(100)
  .regex(new RegExp('^(?!(?:' + controlHeaders + ")$)[!#$%&'*+.^_`|~0-9A-Za-z-]+$"));
const httpsUrl = z.intersection(
  z.url(),
  z
    .string()
    .max(2048)
    .regex(/^[hH][tT][tT][pP][sS]:\/\//),
);
export const appEnvironmentNamePattern =
  /^(?=.*(?:TOKEN|KEY|SECRET|PASSWORD|_ID|_SID|USERNAME|USER|EMAIL|URL)$)[A-Z][A-Z0-9_]*$/;
export const appEnvironmentNameMaxLength = 64;
export const appEnvironmentNameSchema = z
  .string()
  .max(appEnvironmentNameMaxLength)
  .regex(appEnvironmentNamePattern);
const forbiddenCommands = [
  'bash',
  'dash',
  'env',
  'fish',
  'node',
  'npx',
  'npm',
  'python[0-9]*',
  'sh',
  'su',
  'sudo',
  'zsh',
]
  .map((name) => name.replace(/[a-z]/g, (letter) => `[${letter}${letter.toUpperCase()}]`))
  .join('|');
export const appCliCommandSchema = z
  .string()
  .regex(new RegExp(`^(?!(?:${forbiddenCommands})$)[A-Za-z][A-Za-z0-9_-]{0,63}$`));
export const appCliArgvSchema = z
  .array(
    z
      .string()
      .min(1)
      .max(2048)
      .regex(/^[^\u0000]+$/),
  )
  .min(1)
  .max(64);
const readOnly = z.strictObject({ readOnlyHint: z.literal(true) });
const relativePath = z
  .string()
  .min(1)
  .max(2048)
  .regex(/^(?!\/\/|[a-zA-Z][a-zA-Z0-9+.-]*:)[^\\#]+$/);

export const appCliSourceSchema = z.union([
  z.strictObject({
    npm: z
      .string()
      .max(512)
      .regex(
        /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*@\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/,
      ),
  }),
  z.strictObject({
    pypi: z
      .string()
      .max(512)
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*==\d+(?:\.\d+)+(?:[a-zA-Z0-9.]+)?$/),
  }),
  z.strictObject({ url: httpsUrl, sha256: z.string().regex(/^[a-f0-9]{64}$/) }),
]);

export const appHttpReadSchema = z.union([
  z.strictObject({ method: z.literal('GET'), path: relativePath }),
  z.strictObject({ method: z.literal('POST'), path: relativePath, body: z.json() }),
]);

export const appOAuthMetadataSchema = z.strictObject({
  issuer: httpsUrl,
  authorization_endpoint: httpsUrl,
  token_endpoint: httpsUrl,
  registration_endpoint: httpsUrl.optional(),
  response_types_supported: z.tuple([z.literal('code')]).default(['code']),
  code_challenge_methods_supported: z.tuple([z.literal('S256')]).default(['S256']),
  token_endpoint_auth_methods_supported: z.tuple([z.literal('none')]).default(['none']),
  authorization_response_iss_parameter_supported: z.boolean().optional(),
});
export type AppOAuthMetadata = z.output<typeof appOAuthMetadataSchema>;

export const appScopeMaxLength = 500;
const oauthScopes = z
  .array(text(100))
  .max(30)
  .refine(
    (scopes) => scopes.join(' ').length <= appScopeMaxLength,
    `Keep the scopes to ${appScopeMaxLength} characters or fewer when joined with spaces.`,
  )
  .optional();

export const appConnectionSchema = z.union([
  z.strictObject({
    ...fixedServer,
    authentication: z.tuple([z.literal('oauth2')]),
    scopes: oauthScopes,
  }),
  z.strictObject({
    ...fixedServer,
    authentication: z.tuple([z.enum(['bearer', 'x-api-key'])]),
    hints: hints('token'),
  }),
  z.strictObject({
    type: z.literal('mcp'),
    endpoint: z.strictObject({
      source: z.literal('owner'),
      path: z.string().regex(/^\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+$/),
    }),
    authentication: z.tuple([z.literal('oauth2'), z.literal('bearer')]),
    hints: hints('address', 'token'),
  }),
  z.strictObject({
    type: z.literal('http'),
    url: httpsUrl,
    authentication: z.tuple([z.literal('oauth2')]),
    scopes: oauthScopes,
    oauth: appOAuthMetadataSchema.optional(),
    clientIdRequired: z.boolean().optional(),
    hints: hints('clientId'),
  }),
  z.strictObject({
    type: z.literal('http'),
    url: httpsUrl,
    authentication: z.tuple([z.literal('bearer')]),
    hints: hints('token'),
  }),
  z.strictObject({
    type: z.literal('http'),
    url: httpsUrl,
    authentication: z.tuple([z.literal('x-api-key')]),
    apiKeyHeader: appApiKeyHeaderSchema.optional(),
    hints: hints('token'),
  }),
  z.strictObject({
    type: z.literal('cli'),
    command: appCliCommandSchema,
    source: appCliSourceSchema,
    authentication: z.tuple([z.literal('env')]),
    environment: z
      .record(appEnvironmentNameSchema, text(100))
      .refine((value) => Object.keys(value).length >= 1 && Object.keys(value).length <= 16)
      .meta({ minProperties: 1, maxProperties: 16 }),
    hints: z.record(appEnvironmentNameSchema, text(200)).optional(),
  }),
]);

export const appDefinitionSchema = z.strictObject({
  $schema: z.literal(appSchemaId),
  displayName: name(80),
  icon: z
    .string()
    .regex(/^\.\/io\.n8n\.nod\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+\.(?:svg|png|webp)$/)
    .optional(),
  categories: z.array(text(50)).max(10).default([]),
  prompts: z.array(text(240)).min(2).max(4),
  requirements: z.array(text(300)).min(1).max(8),
  limitations: z.array(text(300)).min(1).max(8),
  connection: appConnectionSchema,
});

const contractBase = {
  $schema: z.literal(appContractSchemaId),
  source: httpsUrl,
  output: z.json(),
};

export const appContractSchema = z.union([
  z.strictObject({
    ...contractBase,
    type: z.literal('mcp').default('mcp'),
    tool: z.strictObject({
      name: z
        .string()
        .min(1)
        .max(100)
        .regex(/^(?!replace_)/),
      description: z.string().min(1).max(2000),
      inputSchema: z.object({ type: z.literal('object') }).catchall(z.json()),
      annotations: z.strictObject({ readOnlyHint: z.literal(true) }),
    }),
    input: z.record(z.string(), z.json()),
  }),
  z.strictObject({
    ...contractBase,
    type: z.literal('http'),
    request: appHttpReadSchema,
    annotations: readOnly,
  }),
  z.strictObject({
    ...contractBase,
    type: z.literal('cli'),
    argv: appCliArgvSchema,
    timeoutSeconds: z.number().int().min(1).max(120).default(30),
    format: z.literal('json').default('json'),
    annotations: readOnly,
  }),
  z.strictObject({
    ...contractBase,
    type: z.literal('cli'),
    argv: appCliArgvSchema,
    timeoutSeconds: z.number().int().min(1).max(120).default(30),
    format: z.literal('text'),
    output: z.string().min(1),
    annotations: readOnly,
  }),
]);

export type AppDefinition = z.output<typeof appDefinitionSchema>;
export type AppDefinitionInput = z.input<typeof appDefinitionSchema>;
export type AppContract = z.output<typeof appContractSchema>;
export type AppContractInput = z.input<typeof appContractSchema>;

export interface AppManifest {
  $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json';
  name: string;
  version: string;
  description: string;
  author: { name: string; email?: string; url?: string };
  homepage?: string;
  repository?: string;
  license?: string;
  keywords?: string[];
  extensions: { 'io.n8n.nod': z.output<typeof appExtensionSchema> } & Record<
    string,
    Record<string, unknown>
  >;
}

export interface AppMcpConfig {
  $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json';
  mcpServers: Record<string, { type: 'streamable-http'; url: string }>;
}
