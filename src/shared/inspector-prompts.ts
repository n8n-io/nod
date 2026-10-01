export interface InspectorPrompt {
  id: string;
  turnId: string;
  title: string;
  system: string;
  instruction: string;
  resumed: boolean;
  imageCount: number;
  reason: 'user' | 'secure_resume' | 'steer';
  provider: string;
  model: string;
  createdAt: string;
}

export interface InspectorPromptsResponse {
  prompts: InspectorPrompt[];
  captureEnabled: boolean;
  retentionDays: number;
  dropped: number;
  hasOlder: boolean;
  nextBefore?: string;
  nextBeforeId?: string;
}
