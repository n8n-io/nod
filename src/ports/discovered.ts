export interface DiscoveredTool {
  name: string;
  description?: string;
  inputSchema: unknown;
  annotations?: { readOnlyHint?: boolean };
}

export interface DiscoveredTransport {
  validateEndpoint(endpoint: string): Promise<string>;
  http(
    endpoint: string,
    headers: Record<string, string>,
    method: string,
    body?: unknown,
  ): Promise<{ status: number; body: unknown }>;
  listTools(endpoint: string, headers: Record<string, string>): Promise<DiscoveredTool[]>;
  callTool(
    endpoint: string,
    headers: Record<string, string>,
    name: string,
    input: Record<string, unknown>,
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
  ): Promise<{ url: string; saved: DiscoveredOAuthState }>;
  finish(
    endpoint: string,
    saved: DiscoveredOAuthState,
    code: string,
  ): Promise<DiscoveredOAuthState>;
  refresh(endpoint: string, saved: DiscoveredOAuthState): Promise<DiscoveredOAuthState>;
}
