export const memoryAreas = ['about', 'preferences', 'people', 'routines', 'lessons'] as const;

export type MemoryArea = (typeof memoryAreas)[number];
export type MemoryStatus = 'stated' | 'observed' | 'tentative';
export type MemoryReason =
  'superseded' | 'merged' | 'duplicate' | 'expired' | 'stale' | 'obsolete' | 'contradicted';

export interface MemorySource {
  id: string;
  text: string | null;
  at: string | null;
  channel: string | null;
}

export interface MemoryNote {
  path: string;
  area: MemoryArea;
  text: string;
  status: MemoryStatus;
  inMind: boolean;
  updated: string;
  edited: string | null;
  expires: string | null;
  learnedFrom: 'email' | null;
  sources: MemorySource[];
}

export interface MemoryArchived {
  path: string;
  area: MemoryArea;
  text: string;
  reason: MemoryReason;
  by: string | null;
  archived: string;
  sources: MemorySource[];
}

export interface MemoryView {
  saving: boolean;
  sensitive: boolean;
  notes: MemoryNote[];
  archive: MemoryArchived[];
}

export interface MemoryUpdate extends MemoryView {
  path?: string;
}
