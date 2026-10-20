export const memoryAreas = ['about', 'preferences', 'people', 'routines', 'lessons'] as const;
export const noteChars = 4000;
export const skillDescriptionChars = 200;
export const skillChars = 6000;

export type MemoryArea = (typeof memoryAreas)[number];
export const areaLabels: Record<MemoryArea, string> = {
  about: 'About you',
  preferences: 'Preferences',
  people: 'People',
  routines: 'Routines',
  lessons: 'Lessons',
};
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

export interface LearnedSkill {
  name: string;
  description: string;
  body: string;
  learned: string;
  updated: string;
  edited: string | null;
  task: string | null;
}

export interface MemoryView {
  saving: boolean;
  sensitive: boolean;
  notes: MemoryNote[];
  archive: MemoryArchived[];
  skills: LearnedSkill[];
}

export interface MemoryImported {
  added: number;
  existing: number;
  skipped: number;
}

export interface MemoryUpdate extends MemoryView {
  path?: string;
  imported?: MemoryImported;
}
