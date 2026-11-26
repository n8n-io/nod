import { auth, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';
import { OAuthError, ServerError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import {
  DiscoveredSignInRequired,
  type DiscoveredOAuth,
  type DiscoveredOAuthState,
} from '../../ports/discovered.ts';
import { publicHttps, safeRemoteFetch } from './remote.ts';

class RedirectRejected extends Error {}

const publicSignIn = async (link: string) => (await publicHttps(link)).url.href;

export function createDiscoveredOAuth(
  fetchFn: FetchLike = safeRemoteFetch,
  signInLink: (link: string) => Promise<string> = publicSignIn,
): DiscoveredOAuth {
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
      fetchFn: async (input, init) => {
        signal?.throwIfAborted();
        const response = await fetchFn(input, {
          ...init,
          ...(signal
            ? { signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal }
            : {}),
        });
        if (!response.ok && init?.method === 'POST' && !saved.clientInformation) {
          const body = await response
            .clone()
            .json()
            .catch(() => undefined);
          if (body?.error === 'invalid_redirect_uri')
            throw new RedirectRejected(
              [body.error, body.error_description].filter(Boolean).join(': '),
            );
        }
        return response;
      },
    });
    return { result, url };
  }

  return {
    async begin(endpoint, redirectUri, state, scope, clientId, metadata) {
      const { hostname, pathname } = new URL(redirectUri);
      return start(redirectUri).catch((cause: unknown) => {
        if (!(cause instanceof RedirectRejected) || hostname === '127.0.0.1') throw cause;
        return start(new URL(pathname, 'http://127.0.0.1').href);
      });
      async function start(redirect: string) {
        const saved: DiscoveredOAuthState = {
          redirectUri: redirect,
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
      }
    },
    async finish(endpoint, saved, code) {
      const result = await run(endpoint, saved, { code }, AbortSignal.timeout(30_000));
      if (result.result !== 'AUTHORIZED' || !saved.tokens?.access_token)
        throw new Error('The service did not complete sign-in.');
      return saved;
    },
    async refresh(endpoint, saved, signal) {
      if (!saved.tokens?.refresh_token) throw new DiscoveredSignInRequired();
      const result = await run(endpoint, saved, {}, signal).catch((cause: unknown) => {
        throw cause instanceof OAuthError && !(cause instanceof ServerError)
          ? new DiscoveredSignInRequired()
          : cause;
      });
      if (result.result !== 'AUTHORIZED' || !saved.tokens?.access_token)
        throw new DiscoveredSignInRequired();
      return saved;
    },
  };
}
