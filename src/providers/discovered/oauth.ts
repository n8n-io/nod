import {
  auth,
  refreshAuthorization,
  type OAuthClientProvider,
} from '@modelcontextprotocol/sdk/client/auth.js';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  OAuthError,
  ServerError,
  TemporarilyUnavailableError,
  TooManyRequestsError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js';
import {
  DiscoveredSignInRequired,
  type DiscoveredOAuth,
  type DiscoveredOAuthState,
} from '../../ports/discovered.ts';
import { publicHttps, safeRemoteFetch } from './remote.ts';

const publicSignIn = async (link: string) => (await publicHttps(link)).url.href;

export function createDiscoveredOAuth(
  fetchFn: FetchLike = safeRemoteFetch,
  signInLink: (link: string) => Promise<string> = publicSignIn,
): DiscoveredOAuth {
  const bound =
    (signal?: AbortSignal): FetchLike =>
    (input, init) => {
      signal?.throwIfAborted();
      return fetchFn(input, {
        ...init,
        ...(signal
          ? { signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal }
          : {}),
      });
    };
  async function run(
    endpoint: string,
    saved: DiscoveredOAuthState,
    options: { state?: string; code?: string },
    signal?: AbortSignal,
  ) {
    signal?.throwIfAborted();
    let url: string | undefined;
    const provider: OAuthClientProvider = {
      redirectUrl: saved.redirectUri,
      clientMetadata: {
        client_name: 'Nod',
        redirect_uris: [saved.redirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
        ...(saved.scope ? { scope: saved.scope } : {}),
      },
      state: () => options.state ?? '',
      clientInformation: () => saved.clientInformation,
      saveClientInformation: (value) => {
        saved.clientInformation = value;
      },
      tokens: () => saved.tokens,
      saveTokens: (value) => {
        saved.tokens = value;
        saved.expiresAt =
          value.expires_in === undefined ? undefined : Date.now() + value.expires_in * 1000;
      },
      redirectToAuthorization: (value) => {
        url = value.href;
      },
      saveCodeVerifier: (value) => {
        saved.verifier = value;
      },
      codeVerifier: () => {
        if (!saved.verifier) throw new Error('The sign-in request is unavailable.');
        return saved.verifier;
      },
      saveDiscoveryState: (value) => {
        saved.discovery = value;
      },
      discoveryState: () => saved.discovery,
    };
    const result = await auth(provider, {
      serverUrl: endpoint,
      ...(options.code ? { authorizationCode: options.code } : {}),
      ...(saved.scope ? { scope: saved.scope } : {}),
      fetchFn: bound(signal),
    });
    return { result, url };
  }

  return {
    async begin(endpoint, redirectUri, state, scope, clientId, metadata) {
      const saved: DiscoveredOAuthState = {
        redirectUri,
        ...(scope ? { scope } : {}),
        ...(clientId
          ? {
              clientInformation: {
                client_id: clientId,
                ...(metadata ? { issuer: metadata.issuer } : {}),
              },
            }
          : {}),
        ...(metadata
          ? {
              discovery: {
                authorizationServerUrl: metadata.issuer,
                authorizationServerMetadata: metadata,
              },
            }
          : {}),
      };
      const result = await run(endpoint, saved, { state }, AbortSignal.timeout(30_000));
      if (result.result !== 'REDIRECT' || !result.url)
        throw new Error('The service did not provide a sign-in link.');
      return { url: await signInLink(result.url), saved };
    },
    async finish(endpoint, saved, code) {
      const result = await run(endpoint, saved, { code }, AbortSignal.timeout(30_000));
      if (result.result !== 'AUTHORIZED' || !saved.tokens?.access_token)
        throw new Error('The service did not complete sign-in.');
      return saved;
    },
    async refresh(_endpoint, saved, signal) {
      const refreshToken = saved.tokens?.refresh_token;
      const { clientInformation, discovery } = saved;
      if (!refreshToken || !clientInformation || !discovery) throw new DiscoveredSignInRequired();
      signal?.throwIfAborted();
      const tokens = await refreshAuthorization(discovery.authorizationServerUrl, {
        metadata: discovery.authorizationServerMetadata,
        clientInformation,
        refreshToken,
        resource: discovery.resourceMetadata?.resource,
        fetchFn: bound(signal),
      }).catch((cause: unknown) => {
        if (!(cause instanceof OAuthError)) throw cause;
        const reason = [cause.errorCode, cause.message].filter(Boolean).join(': ').slice(0, 500);
        if (cause instanceof TooManyRequestsError)
          throw Object.assign(new Error(reason), { reason: 'rate_limited' });
        if (cause instanceof ServerError || cause instanceof TemporarilyUnavailableError)
          throw Object.assign(new Error(reason), { reason: 'unavailable' });
        throw new DiscoveredSignInRequired(reason);
      });
      return {
        ...saved,
        tokens: { ...saved.tokens, ...tokens },
        expiresAt:
          tokens.expires_in === undefined ? undefined : Date.now() + tokens.expires_in * 1000,
      };
    },
  };
}
