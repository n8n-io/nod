export interface GeneratedAudio {
  bytes: Buffer;
  mimeType: string;
  fileName: string;
}
export interface SpeechProvider {
  id: string;
  configured: boolean;
  synthesize(text: string, signal?: AbortSignal): Promise<GeneratedAudio>;
}
