import type { PasswordManagerLogin } from '../shared/contracts.ts';

export type { PasswordManagerLogin };

export interface PasswordManagerSecret {
  title: string;
  username: string;
  password: string;
  authenticatorKey?: string;
}

export type PasswordManagerFailure = 'unavailable' | 'missing' | 'failed';

export class PasswordManagerError extends Error {
  constructor(
    readonly reason: PasswordManagerFailure,
    message: string,
  ) {
    super(message);
  }
}

export interface PasswordManager {
  readonly name: string;
  logins(account: string, origin: string, signal?: AbortSignal): Promise<PasswordManagerLogin[]>;
  login(
    account: string,
    origin: string,
    id: string,
    signal?: AbortSignal,
  ): Promise<PasswordManagerSecret>;
  close(): Promise<void>;
}
