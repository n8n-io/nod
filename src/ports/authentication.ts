import type { AccountUser } from '../shared/account.ts';

export interface AuthenticatedSession {
  id: string;
  expiresAt: Date;
  user: AccountUser;
  avatarSource?: string;
  givenName?: string;
  cookies?: string[];
}

export interface AuthenticationAvatar {
  bytes: Uint8Array;
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
}

export interface AuthenticationProvider {
  readonly configured: boolean;
  initialize(): Promise<void>;
  session(headers: Headers, refresh?: boolean): Promise<AuthenticatedSession | null>;
  signIn(headers: Headers): Promise<Response>;
  signOut(headers: Headers): Promise<Response>;
  callback(request: Request): Promise<Response>;
  avatar?(session: AuthenticatedSession): Promise<AuthenticationAvatar | null>;
  forget?(
    userId: string,
    dryRun: boolean,
  ): Promise<{ user: boolean; sessions: number; accounts: number }>;
}
