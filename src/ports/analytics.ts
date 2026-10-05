export interface ProductAnalytics {
  capture(input: {
    distinctId: string;
    event: string;
    properties: Record<string, string | number | boolean>;
  }): void;
  shutdown(): Promise<void>;
}
