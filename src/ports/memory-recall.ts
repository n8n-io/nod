import type { MemoryNote } from '../shared/memory.ts';
import type { Presentation } from '../shared/presentation.ts';

export interface MemoryReplyVisual {
  text: string;
  presentation: Presentation;
}

export type MemoryReplyReview =
  | string
  | {
      text: string;
      presentationSupported?: boolean;
      correctedVisual?: MemoryReplyVisual;
    };

export interface MemoryBrief {
  mode: 'personalize' | 'recall' | 'aggregate';
  facts: MemoryNote[];
  messages: Array<{
    id: string;
    role: string;
    text: string;
    at: string;
    shortened: boolean;
  }>;
  searches: Array<{
    query: string;
    totalMatches: number;
    complete: boolean;
    nextCursor: string | null;
  }>;
  reads?: Array<{ action: string; args: Record<string, unknown>; result: unknown }>;
  readsTruncated?: boolean;
  lastDelivery?: {
    text: string;
    presentation?: { type: Presentation['type']; text: string };
    truncated?: boolean;
  };
  truncated?: boolean;
}
