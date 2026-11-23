import { z } from 'zod';
import {
  appEnvironmentNameSchema,
  appCliArgvSchema,
  appApiKeyHeaderSchema,
  appOAuthMetadataSchema,
  appScopeMaxLength,
} from '../shared/app-definitions.ts';

const remoteSpec = String.raw`(?:https|git\+https):\/\/[^\s]+`;
const cliSourceSchema = z.union([
  z
    .object({
      npm: z
        .string()
        .max(512)
        .regex(
          new RegExp(
            String.raw`^(?:(?:@[A-Za-z0-9][\w.~-]*\/)?[A-Za-z0-9][\w.~-]*(?:@(?!(?:file|link|git\+file):|\.{0,2}\/|~)[^@\s](?:[^@\x00-\x1f]*[^@\s])?)?|[A-Za-z0-9][\w.-]*\/[\w.-]+(?:#[^\s#]+)?|(?:github|gitlab|bitbucket):[^\s]+|${remoteSpec})$`,
          ),
        ),
    })
    .strict(),
  z
    .object({
      pypi: z
        .string()
        .max(512)
        .regex(
          new RegExp(
            String.raw`^(?:[A-Za-z0-9](?:[\w.-]*[A-Za-z0-9])?(?:\[[\w., -]+\])?(?:\s*(?:===|==|!=|~=|>=|<=|>|<)\s*[\w.*+!-]+(?:\s*,\s*(?:===|==|!=|~=|>=|<=|>|<)\s*[\w.*+!-]+)*)?|${remoteSpec})$`,
          ),
        ),
    })
    .strict(),
  z
    .object({
      url: z.url({ protocol: /^https$/, normalize: true }).max(2048),
      sha256: z
        .string()
        .toLowerCase()
        .regex(/^[a-f0-9]{64}$/)
        .optional(),
    })
    .strict(),
]);
const envName = appEnvironmentNameSchema;
export const appAccessSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('http'),
      endpoint: z.url().max(2048),
      auth: z.enum(['bearer', 'x-api-key', 'oauth']).default('bearer'),
      testPath: z.string().min(1).max(2048),
      testMethod: z.enum(['GET', 'POST']).optional(),
      testBody: z.json().optional(),
      apiKeyHeader: appApiKeyHeaderSchema.optional(),
      scope: z.string().min(1).max(appScopeMaxLength).optional(),
      clientIdRequired: z.boolean().optional(),
      oauth: appOAuthMetadataSchema.optional(),
    })
    .refine(
      (path) =>
        (path.testBody === undefined || path.testMethod === 'POST') &&
        (path.testMethod !== 'POST' || path.testBody !== undefined) &&
        (path.auth === 'oauth' || (!path.oauth && !path.scope && !path.clientIdRequired)) &&
        (!path.apiKeyHeader || path.auth === 'x-api-key'),
    ),
  z.object({
    kind: z.literal('mcp'),
    endpoint: z.url().max(2048),
    auth: z.enum(['bearer', 'x-api-key', 'oauth']).default('bearer'),
    testPath: z.string().max(500).optional(),
    scope: z.string().trim().min(1).max(appScopeMaxLength).optional(),
    clientIdRequired: z.boolean().optional(),
  }),
  z.object({
    kind: z.literal('cli'),
    command: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/),
    auth: z.literal('env').default('env'),
    env: z
      .array(envName)
      .min(1)
      .max(16)
      .refine((names) => new Set(names).size === names.length),
    source: cliSourceSchema,
    testArgv: appCliArgvSchema.optional(),
    testTimeoutSeconds: z.number().int().min(1).max(120).optional(),
    testFormat: z.enum(['json', 'text']).optional(),
  }),
]);
