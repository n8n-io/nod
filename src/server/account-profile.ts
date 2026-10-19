import type { RuntimeAccount } from '../ports/agent.ts';

export function runtimeAccount(profile: {
  name: string | null;
  givenName: string | null;
  email: string | null;
  preferredName: string | null;
}): RuntimeAccount | undefined {
  const fullName = profile.name || null;
  const preferredName =
    profile.preferredName || profile.givenName || fullName?.split(/\s+/)[0] || null;
  if (!preferredName && !fullName && !profile.email) return undefined;
  return { preferredName, fullName, email: profile.email || null };
}
