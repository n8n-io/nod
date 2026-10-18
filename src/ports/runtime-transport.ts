export type RuntimeConfiguration = {
  ownerId: string;
  generation: string;
  environment: Record<string, string>;
};

export interface RuntimeTransport {
  deploymentClosed?(): Promise<boolean>;
  deploymentStopped?(ownerId: string, generation: string | null): Promise<boolean>;
  status(ownerId: string): Promise<{ generation: string | null; stopped: boolean }>;
  start(configuration: RuntimeConfiguration): Promise<void>;
  stop(ownerId: string, generation: string): Promise<void>;
  prepareDeployment?(
    ownerId: string,
    generation: string,
    input: DeploymentInput,
  ): Promise<'stopped' | 'busy'>;
  removeStorage?(ownerId: string, dryRun: boolean): Promise<number>;
  fetch(ownerId: string, request: Request): Promise<Response>;
  close(): Promise<void>;
}
import type { DeploymentInput } from './deployment.ts';
