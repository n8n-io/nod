export interface IntegrationIdentityCheckpoint {
  read(): Promise<string | undefined>;
  commit(publicKey: string): Promise<void>;
}
