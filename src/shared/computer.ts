export interface ComputerStatus {
  available: boolean;
  enabled: boolean;
  permissions: { accessibility: boolean; screen: boolean };
  apps: { bundleId: string; name: string }[];
}
export type ComputerPermission = 'accessibility' | 'screen';
