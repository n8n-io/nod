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
  setPersonProperties?(
    input: {
      distinctId: string;
      properties: Record<string, string | number | boolean | string[]>;
      unset?: readonly string[];
    },
    signal: AbortSignal,
  ): Promise<boolean>;
  shutdown(): Promise<void>;
}
