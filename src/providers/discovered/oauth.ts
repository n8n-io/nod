import { auth, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';
import { OAuthError, ServerError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import {
  DiscoveredSignInRequired,
  type DiscoveredOAuth,
  type DiscoveredOAuthState,
} from '../../ports/discovered.ts';
import { publicUrl } from '../agent-browser/network.ts';
import { safeRemoteFetch } from './remote.ts';

async function publicSignIn(link: string) {
  const destination = await publicUrl(link);
  if (destination.url.protocol !== 'https:')
    throw new Error('The service sign-in link must use HTTPS.');
  return destination.url.href;
}

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
      fetchFn: (input, init) => {
        signal?.throwIfAborted();
        return fetchFn(input, {
          ...init,
          ...(signal
            ? { signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal }
            : {}),
        });
      },
    });
    return { result, url };
  }

  return {
    async begin(endpoint, redirectUri, state, scope, clientId) {
      const saved: DiscoveredOAuthState = {
        redirectUri,
        ...(scope ? { scope } : {}),
        ...(clientId ? { clientInformation: { client_id: clientId } } : {}),
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
