import { createHash, createHmac, hkdfSync, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { DeploymentRequest } from '../ports/deployment.ts';

export const deploymentPath = '/api/deployment';
export const deprovisionPath = '/api/deprovision';
export const deploymentHeader = 'x-otto-deployment';
export const deploymentBodyLimit = 2048;
export const deploymentMaximumDuration = 600_000;

const environmentSchema = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/);
export const deploymentInputSchema = z
  .object({
    nonce: z.uuid(),
    targetRelease: z.string().regex(/^[a-f0-9]{40}$/),
    deadline: z.number().int().safe().positive(),
  })
  .strict();
export const deploymentRequestSchema = deploymentInputSchema
  .extend({
    action: z.enum(['prepare', 'status', 'activate', 'abort', 'complete']),
    previousRelease: z.string().regex(/^[a-f0-9]{40}$/),
  })
  .strict();
export const deprovisionRequestSchema = z
  .object({ ownerId: z.uuid(), dryRun: z.boolean(), release: z.boolean() })
  .strict();
const capabilities = {
  deployment: {
    target: deploymentPath,
    info: 'deployment-control',
    schema: deploymentRequestSchema,
  },
  deprovision: {
    target: deprovisionPath,
    info: 'deprovision-control',
    schema: deprovisionRequestSchema,
  },
} as const;
type Capability = keyof typeof capabilities;
const claimsSchema = z
  .object({
    version: z.literal(1),
    capability: z.enum(['deployment', 'deprovision']),
    environment: environmentSchema,
    requestId: z.uuid(),
    expiresAt: z.number().int().safe(),
    method: z.literal('POST'),
    target: z.enum([deploymentPath, deprovisionPath]),
    bodyHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

export class DeploymentControlError extends Error {
  readonly status: number;
  constructor(status = 503) {
    super('The deployment operation could not be completed.');
    this.status = status;
  }
}

export function deriveDeploymentKey(
  master: Uint8Array,
  environment: string,
  capability: Capability = 'deployment',
) {
  if (master.length !== 32 || !environmentSchema.safeParse(environment).success)
    throw new DeploymentControlError();
  return Buffer.from(
    hkdfSync(
      'sha256',
      master,
      Buffer.from('otto-deployment-v1'),
      Buffer.from(JSON.stringify([environment, capabilities[capability].info])),
      32,
    ),
  );
}

export function signDeploymentRequest(options: {
  masterKey: Uint8Array;
  environment: string;
  body: Uint8Array;
  now?: number;
  requestId?: string;
  capability?: Capability;
}) {
  const capability = options.capability ?? 'deployment';
  if (options.body.byteLength > deploymentBodyLimit) throw new DeploymentControlError(400);
  const claims = claimsSchema.parse({
    version: 1,
    capability,
    environment: options.environment,
    requestId: options.requestId ?? randomUUID(),
    expiresAt: (options.now ?? Date.now()) + 30_000,
    method: 'POST',
    target: capabilities[capability].target,
    bodyHash: createHash('sha256').update(options.body).digest('hex'),
  });
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signature = createHmac(
    'sha256',
    deriveDeploymentKey(options.masterKey, options.environment, capability),
  )
    .update(payload)
    .digest('base64url');
  return `${payload}.${signature}`;
}

type VerifierOptions = {
  masterKey: Uint8Array;
  environment: string;
  now?: () => number;
  claimNonce?(requestId: string, expiresAt: number): Promise<boolean>;
};

export function createDeploymentVerifier(
  options: VerifierOptions,
): (
  token: unknown,
  method: string,
  target: string,
  body: Uint8Array,
) => Promise<DeploymentRequest> {
  return createVerifier(options, 'deployment');
}

export function createDeprovisionVerifier(
  options: VerifierOptions,
): (
  token: unknown,
  method: string,
  target: string,
  body: Uint8Array,
) => Promise<z.infer<typeof deprovisionRequestSchema>> {
  return createVerifier(options, 'deprovision');
}

function createVerifier<C extends Capability>(options: VerifierOptions, capability: C) {
  const key = deriveDeploymentKey(options.masterKey, options.environment, capability);
  const expectedTarget = capabilities[capability].target;
  const now = options.now ?? Date.now;
  const accepted = new Map<string, number>();
  return async function verify(token: unknown, method: string, target: string, body: Uint8Array) {
    if (
      typeof token !== 'string' ||
      token.length > 2048 ||
      method !== 'POST' ||
      target !== expectedTarget ||
      body.byteLength > deploymentBodyLimit
    )
      throw new DeploymentControlError(401);
    try {
      const [payload, signature, extra] = token.split('.');
      if (
        !payload ||
        !signature ||
        extra !== undefined ||
        !/^[A-Za-z0-9_-]+$/.test(payload) ||
        !/^[A-Za-z0-9_-]{43}$/.test(signature)
      )
        throw new Error();
      const expected = createHmac('sha256', key).update(payload).digest();
      const actual = Buffer.from(signature, 'base64url');
      if (
        actual.toString('base64url') !== signature ||
        actual.length !== expected.length ||
        !timingSafeEqual(actual, expected)
      )
        throw new Error();
      const claims = claimsSchema.parse(JSON.parse(Buffer.from(payload, 'base64url').toString()));
      const time = now();
      if (
        claims.capability !== capability ||
        claims.target !== expectedTarget ||
        claims.environment !== options.environment ||
        claims.expiresAt <= time ||
        claims.expiresAt > time + 35_000 ||
        claims.bodyHash !== createHash('sha256').update(body).digest('hex')
      )
        throw new Error();
      const input = capabilities[capability].schema.parse(
        JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(body)),
      ) as z.infer<(typeof capabilities)[C]['schema']>;
      if (options.claimNonce) {
        if (!(await options.claimNonce(claims.requestId, claims.expiresAt))) throw new Error();
      } else {
        for (const [id, expiry] of accepted) if (expiry <= time) accepted.delete(id);
        if (accepted.has(claims.requestId)) throw new Error();
        accepted.set(claims.requestId, claims.expiresAt);
      }
      return input;
    } catch {
      throw new DeploymentControlError(401);
    }
  };
}
