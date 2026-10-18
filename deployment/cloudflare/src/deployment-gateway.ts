import { z } from 'zod';
import type { DeploymentReceipt } from '../../../src/ports/deployment.ts';
import { parseCredentialKey } from '../../../src/providers/environment/key-store.ts';
import {
  createDeploymentVerifier,
  createDeprovisionVerifier,
  deploymentBodyLimit,
  DeploymentControlError,
  deploymentHeader,
  deploymentPath,
  deprovisionPath,
} from '../../../src/server/deployment-auth.ts';
import { createDeploymentBarrier, type DeploymentState } from './deployment-barrier.ts';
import { boundedBody, environmentName, environmentValues } from './protocol.ts';

export function createGatewayDeployment(options: {
  storage: DurableObjectStorage;
  environment: string;
  gatewayEnvironment: string;
  requireInitialization?: boolean;
  forward(request: Request): Promise<Response>;
}) {
  const environment = environmentName(options.environment);
  const configured = environmentValues(JSON.parse(options.gatewayEnvironment));
  let verify: ReturnType<typeof createDeploymentVerifier> | undefined;
  let verifyDeprovision: ReturnType<typeof createDeprovisionVerifier> | undefined;
  const claimNonce = (requestId: string, expiresAt: number) =>
    options.storage.transaction(async (storage) => {
      const raw = (await storage.get<Record<string, number>>('deployment-replays')) ?? {};
      const current = Date.now();
      const accepted = z.record(z.uuid(), z.number().int().safe()).parse(raw);
      for (const [id, expiry] of Object.entries(accepted))
        if (expiry <= current) delete accepted[id];
      if (accepted[requestId]) return false;
      accepted[requestId] = expiresAt;
      await storage.put('deployment-replays', accepted);
      return true;
    });
  const removal = async () => {
    const value = await options.storage.get<{ ownerId: string; dryRun: boolean; until: number }>(
      'deprovisioning',
    );
    return value && value.until > Date.now() ? value : undefined;
  };
  const barrier = createDeploymentBarrier({
    read: () => options.storage.get('deployment-barrier'),
    write: (state: DeploymentState) => options.storage.put('deployment-barrier', state),
    currentRelease: configured.OTTO_RELEASE ?? '',
    requireInitialization: options.requireInitialization,
    prepare: async (_input, request) => {
      const response = await options.forward(request);
      if (!response.ok) {
        await response.body?.cancel();
        throw new DeploymentControlError();
      }
      const result = await boundedResponse(response);
      const parsed = z
        .object({
          ok: z.literal(true),
          receipts: z
            .array(
              z
                .object({ ownerId: z.uuid(), generation: z.string().regex(/^[1-9]\d{0,18}$/) })
                .strict(),
            )
            .max(1024),
        })
        .strict()
        .parse(result);
      return parsed.receipts as DeploymentReceipt[];
    },
    resume: async (_input, request) => {
      const response = await options.forward(request);
      if (!response.ok) {
        await response.body?.cancel();
        throw new DeploymentControlError();
      }
      z.object({ ok: z.literal(true) })
        .strict()
        .parse(await boundedResponse(response));
    },
  });
  return {
    closed: () => barrier.closed(),
    async handle(request: Request) {
      verify ??= createDeploymentVerifier({
        masterKey: parseCredentialKey(configured.OTTO_MASTER_KEY ?? ''),
        environment,
        claimNonce,
      });
      const url = new URL(request.url);
      const bytes = await boundedBody(request, deploymentBodyLimit);
      const input = await verify(
        request.headers.get(deploymentHeader),
        request.method,
        url.pathname + url.search,
        bytes,
      );
      if (url.pathname !== deploymentPath) throw new DeploymentControlError(404);
      if (input.action === 'prepare' && (await removal())) throw new DeploymentControlError(409);
      return barrier.handle(input, new Request(request, { body: bytes }));
    },
    async deprovisioning(ownerId: string, dryRun: boolean) {
      const active = await removal();
      return active?.ownerId === ownerId && (dryRun || !active.dryRun);
    },
    async deprovision(request: Request) {
      verifyDeprovision ??= createDeprovisionVerifier({
        masterKey: parseCredentialKey(configured.OTTO_MASTER_KEY ?? ''),
        environment,
        claimNonce,
      });
      const url = new URL(request.url);
      const bytes = await boundedBody(request, deploymentBodyLimit);
      const input = await verifyDeprovision(
        request.headers.get(deploymentHeader),
        request.method,
        url.pathname + url.search,
        bytes,
      );
      if (url.pathname !== deprovisionPath) throw new DeploymentControlError(404);
      if ((await barrier.closed()) || (await removal())) throw new DeploymentControlError(409);
      await options.storage.put('deprovisioning', {
        ownerId: input.ownerId.toLowerCase(),
        dryRun: input.dryRun,
        until: Date.now() + 15 * 60_000,
      });
      try {
        const response = await options.forward(new Request(request, { body: bytes }));
        if (!response.ok) {
          await response.body?.cancel();
          throw new DeploymentControlError(response.status === 409 ? 409 : 503);
        }
        return await boundedResponse(response);
      } finally {
        await options.storage.delete('deprovisioning');
      }
    },
  };
}

async function boundedResponse(response: Response) {
  if (!response.body) throw new DeploymentControlError();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.byteLength;
      if (size > 128 * 1024) throw new DeploymentControlError();
      chunks.push(item.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(
      new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes),
    ) as unknown;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
