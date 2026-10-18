import type { TenantRuntimeHost } from '../ports/tenant-runtime.ts';
import {
  createDeploymentVerifier,
  createDeprovisionVerifier,
  DeploymentControlError,
  deploymentHeader,
} from './deployment-auth.ts';

export function createDeploymentControl(options: {
  masterKey: Uint8Array;
  environment: string;
  release?: string;
  runtimes: TenantRuntimeHost;
}) {
  const verify = createDeploymentVerifier(options);
  return async (token: unknown, method: string, target: string, body: Uint8Array) => {
    const input = await verify(token, method, target, body);
    if (input.previousRelease !== options.release) throw new DeploymentControlError(409);
    const operation = {
      nonce: input.nonce,
      targetRelease: input.targetRelease,
      deadline: input.deadline,
    };
    if (input.action === 'prepare' && options.runtimes.prepareDeployment)
      return { ok: true, receipts: await options.runtimes.prepareDeployment(operation) };
    if (
      (input.action === 'abort' ||
        (input.action === 'complete' && input.previousRelease === input.targetRelease)) &&
      options.runtimes.resumeDeployment
    ) {
      await options.runtimes.resumeDeployment(operation);
      return { ok: true };
    }
    throw new DeploymentControlError(409);
  };
}

export function createDeprovisionControl(options: {
  masterKey: Uint8Array;
  environment: string;
  runtimes: TenantRuntimeHost;
}) {
  const verify = createDeprovisionVerifier(options);
  return async (token: unknown, method: string, target: string, body: Uint8Array) => {
    const input = await verify(token, method, target, body);
    if (!options.runtimes.deprovision) throw new DeploymentControlError(409);
    return {
      ok: true,
      report: await options.runtimes.deprovision(input.ownerId, {
        dryRun: input.dryRun,
        release: input.release,
      }),
    };
  };
}

export { deploymentHeader };
