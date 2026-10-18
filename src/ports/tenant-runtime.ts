import type { DeploymentInput, DeploymentReceipt } from './deployment.ts';

export type AccountRemoval = {
  user: boolean;
  sessions: number;
  accounts: number;
  settings: number;
};

export type DeprovisionReport = {
  dryRun: boolean;
  running: boolean;
  released: boolean;
  storageObjects: number;
  account: AccountRemoval;
  tenant: { registered: boolean; role: boolean; schemas: number; channelAccounts: number };
};

export interface TenantRuntimeHost {
  fetch(
    ownerId: string,
    request: Request,
    options: {
      developer: boolean;
      kind?: 'user' | 'webhook' | 'wake';
    },
  ): Promise<Response>;
  warm?(ownerId: string): Promise<void>;
  prepareDeployment?(input: DeploymentInput): Promise<DeploymentReceipt[]>;
  resumeDeployment?(input: DeploymentInput): Promise<void>;
  deprovision?(
    ownerId: string,
    options: { dryRun: boolean; release: boolean },
  ): Promise<DeprovisionReport>;
  close(): Promise<void>;
}
