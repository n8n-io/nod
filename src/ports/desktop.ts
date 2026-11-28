export type DesktopRequest = { op: string } & Record<string, unknown>;

export interface DesktopControl {
  readonly paired?: boolean;
  readonly session?: string;
  onDisconnect?(callback: () => void): void;
  close?(): Promise<void>;
  request(request: DesktopRequest, signal?: AbortSignal): Promise<Record<string, unknown>>;
}
