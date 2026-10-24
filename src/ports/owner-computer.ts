export interface MacApp {
  name: string;
  bundleId: string;
}
export type ComputerPermissionKind = 'accessibility' | 'screen';
export interface MacAppAction {
  app: string;
  action: 'press' | 'set' | 'focus' | 'showMenu' | 'raise' | 'type' | 'key';
  targetToken: string;
  ref?: string;
  value?: string;
  text?: string;
  key?: string;
}
export interface OwnerComputer {
  readonly appControlAvailable?: boolean;
  shell(
    command: string,
    options: { signal: AbortSignal; timeoutMs?: number },
  ): Promise<{ exitCode: number; output: string }>;
  readFile?(path: string, maxBytes: number, signal: AbortSignal): Promise<Buffer>;
  apps?(signal: AbortSignal): Promise<MacApp[]>;
  resolve?(app: string, signal: AbortSignal): Promise<MacApp | null>;
  identify?(app: string, signal: AbortSignal): Promise<MacApp | null>;
  open?(app: string, signal: AbortSignal): Promise<MacApp>;
  look?(app: string, signal: AbortSignal, scope: string): Promise<{ app: MacApp; tree: string }>;
  inspect?(
    app: string,
    ref: string | undefined,
    signal: AbortSignal,
    scope: string,
  ): Promise<{ label: string; token: string }>;
  act?(action: MacAppAction, signal: AbortSignal): Promise<void>;
  screenshot?(app: string, signal: AbortSignal): Promise<{ app: MacApp; png: Buffer }>;
  permissions?(): Promise<Record<ComputerPermissionKind, boolean>>;
  requestPermission?(
    kind: ComputerPermissionKind,
  ): Promise<Record<ComputerPermissionKind, boolean>>;
  dispose(): void;
}
