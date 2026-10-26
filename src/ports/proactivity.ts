export interface ObservationSource {
  id: string;
  label: string;
  description: string;
  revision: string;
  readable: boolean;
  pollIntervalMs?: number;
  changeToken?: string;
  mode?: 'prepare' | 'classic';
  tools?: boolean;
}

export interface ObservationQuery {
  revision?: string;
  ids?: string[];
  since?: string;
  cursor?: string;
  asOf?: string;
  query?: string;
  tool?: string;
  args?: Record<string, unknown>;
}

export interface ObservationRecord {
  id: string;
  version: string;
  available: boolean;
  error?: 'unavailable';
  url?: string;
  data: Record<string, unknown>;
}

export interface ObservationBatch {
  records: ObservationRecord[];
  nextCursor?: string;
}

export interface ObservationProvider {
  id: string;
  sources(): Promise<ObservationSource[]>;
  read(sourceId: string, query: ObservationQuery, signal: AbortSignal): Promise<ObservationBatch>;
}

export class ObservationCursorExpired extends Error {}
