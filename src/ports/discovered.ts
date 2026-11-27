import type { IntegrationFile } from './integrations.ts';
import type { AppOAuthMetadata } from '../shared/app-definitions.ts';
export class DiscoveredSignInRequired extends Error {
  constructor(reason?: string) {
    super(
      reason
        ? `The service refused the saved sign-in (${reason}). Connect this account again.`
        : 'Connect this account again.',
    );
  }
}

export interface DiscoveredTool {
  name: string;
  description?: string;
  inputSchema: unknown;
  annotations?: Record<string, unknown>;
}

export interface DiscoveredCatalog {
  tools: DiscoveredTool[];
  instructions?: string;
}

export interface DiscoveredTransport {
  validateEndpoint(endpoint: string): Promise<string>;
  http(
    endpoint: string,
    headers: Record<string, string>,
    method: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<{ status: number; body: unknown } | { status: number; file: IntegrationFile }>;
  listTools(
    endpoint: string,
    headers: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<DiscoveredCatalog>;
  callTool(
    endpoint: string,
    headers: Record<string, string>,
    name: string,
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown>;
}
import type { OAuthDiscoveryState } from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientInformationMixed,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';

export type DiscoveredOAuthState = {
  redirectUri: string;
  scope?: string;
  clientInformation?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  expiresAt?: number;
  verifier?: string;
  discovery?: OAuthDiscoveryState;
};

export interface DiscoveredOAuth {
  begin(
    endpoint: string,
    redirectUri: string,
    state: string,
    scope?: string,
    clientId?: string,
    metadata?: AppOAuthMetadata,
  ): Promise<{ url: string; saved: DiscoveredOAuthState }>;
  finish(
    endpoint: string,
    saved: DiscoveredOAuthState,
    code: string,
  ): Promise<DiscoveredOAuthState>;
  refresh(
    endpoint: string,
    saved: DiscoveredOAuthState,
    signal?: AbortSignal,
  ): Promise<DiscoveredOAuthState>;
}
