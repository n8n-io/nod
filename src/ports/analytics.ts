export interface ProductAnalytics {
  capture(
    input: {
      distinctId: string;
      event: string;
      properties: Record<string, string | number | boolean | string[]>;
      uuid?: string;
      timestamp?: Date;
      consentRevision?: string;
    },
    signal: AbortSignal,
  ): void;
  shutdown(): Promise<void>;
}
