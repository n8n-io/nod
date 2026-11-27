export interface BaselineVerificationEmail {
  id: string;
  receivedAt: number;
  sender: string;
  recipients: string[];
  authenticatedDomain: string;
  text: string;
}

declare module '../../src/ports/integrations.ts' {
  interface IntegrationProvider {
    verificationEmails?(
      accountId: string,
      query: { recipient: string; senderDomain: string; after: number; before: number },
      signal: AbortSignal,
    ): Promise<BaselineVerificationEmail[] | undefined>;
  }
}
