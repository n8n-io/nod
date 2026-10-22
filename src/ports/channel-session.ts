export interface ChannelSession {
  get(slot: string): Promise<string | undefined>;
  set(entries: Record<string, string | null>): Promise<void>;
  clear(): Promise<void>;
  close(): Promise<void>;
}

export interface ChannelSessionStore {
  open(): Promise<ChannelSession>;
}
