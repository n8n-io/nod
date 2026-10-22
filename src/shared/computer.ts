export interface ComputerStatus {
  available: boolean;
  appControlAvailable: boolean;
  enabled: boolean;
  permissions: { accessibility: boolean; screen: boolean };
  permissionError?: string;
  apps: { bundleId: string; name: string }[];
}
export type ComputerPermission = 'accessibility' | 'screen';
