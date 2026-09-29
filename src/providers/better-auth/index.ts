import { betterAuth } from 'better-auth';
import { getMigrations } from 'better-auth/db/migration';
import type { Pool } from 'pg';
import type { AuthenticationProvider } from '../../ports/authentication.ts';
import { googleAvatarUrl, loadGoogleAvatar } from './avatar.ts';

export function createGoogleAuthentication(options: {
  database: Pool;
  origin: string;
  secret: string;
  environment: string;
  clientId: string;
  clientSecret: string;
}): AuthenticationProvider {
  const origin = new URL(options.origin).origin;
  if (options.secret.length < 32 || !options.clientId || !options.clientSecret)
    throw new Error('Google authentication configuration is incomplete.');
  const auth = betterAuth({
    appName: 'Otto',
    baseURL: origin,
    basePath: '/api/auth',
    secret: options.secret,
    database: options.database,
    trustedOrigins: [origin],
    emailAndPassword: { enabled: false },
    socialProviders: {
      google: {
        clientId: options.clientId,
        clientSecret: options.clientSecret,
        scope: ['openid', 'email', 'profile'],
        prompt: 'select_account',
        overrideUserInfoOnSignIn: true,
        mapProfileToUser: (profile) => ({
          givenName:
            typeof profile.given_name === 'string' ? profile.given_name.slice(0, 100) : null,
        }),
      },
    },
    user: {
      additionalFields: { givenName: { type: 'string', required: false } },
    },
    account: {
      accountLinking: { enabled: false },
      encryptOAuthTokens: true,
      storeStateStrategy: 'database',
    },
    session: {
      expiresIn: 60 * 60 * 24 * 7,
      cookieCache: { enabled: false },
    },
    advanced: {
      database: { generateId: 'uuid' },
      cookiePrefix: `otto-${options.environment}`,
      useSecureCookies: origin.startsWith('https:'),
      defaultCookieAttributes: { httpOnly: true, sameSite: 'lax', path: '/' },
    },
    logger: { disabled: true },
  });
  return {
    configured: true,
    async initialize() {
      const migrations = await getMigrations(auth.options);
      await migrations.runMigrations();
    },
    async session(headers) {
      const result = await auth.api.getSession({
        headers,
        query: { disableCookieCache: true, disableRefresh: true },
      });
      if (!result || !result.user.emailVerified || result.session.expiresAt <= new Date())
        return null;
      const avatarSource = googleAvatarUrl(result.user.image);
      const givenName =
        typeof result.user.givenName === 'string' ? result.user.givenName.trim() : '';
      return {
        id: result.session.id,
        expiresAt: result.session.expiresAt,
        ...(avatarSource ? { avatarSource } : {}),
        ...(givenName ? { givenName } : {}),
        user: {
          id: result.user.id,
          name: result.user.name,
          email: result.user.email,
          avatarUrl: null,
        },
      };
    },
    signIn(headers) {
      return auth.api.signInSocial({
        headers,
        body: {
          provider: 'google',
          callbackURL: `${origin}/`,
          newUserCallbackURL: `${origin}/onboarding`,
          errorCallbackURL: `${origin}/login?error=sign-in`,
          disableRedirect: true,
        },
        asResponse: true,
      });
    },
    signOut(headers) {
      return auth.api.signOut({ headers, asResponse: true });
    },
    async callback(request) {
      const headers = new Headers({ 'cache-control': 'no-store' });
      try {
        const result = await auth.handler(request);
        const location = result.headers.get('location');
        const destination = location ? new URL(location, origin) : null;
        if (
          result.status >= 300 &&
          result.status < 400 &&
          destination?.origin === origin &&
          ['/', '/onboarding'].includes(destination.pathname) &&
          !destination.search &&
          !destination.hash
        )
          return result;
        for (const cookie of result.headers.getSetCookie()) headers.append('set-cookie', cookie);
        await result.body?.cancel();
      } catch {}
      headers.set('location', `${origin}/login?error=sign-in`);
      return new Response(null, { status: 302, headers });
    },
    avatar: (session) => loadGoogleAvatar(session.avatarSource ?? null),
  };
}
