import type {
  OnboardingEmailDelivery,
  OnboardingEmailSubmission,
} from '../../ports/onboarding-email.ts';
import { onboardingPersonProperties } from '../../shared/onboarding-analytics.ts';

export function createN8nOnboardingEmail(options: {
  url?: string;
  request?: typeof fetch;
}): OnboardingEmailDelivery {
  let endpoint: URL | undefined;
  if (options.url) {
    endpoint = new URL(options.url);
    if (
      endpoint.protocol !== 'https:' ||
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash
    )
      throw new Error('The onboarding email URL must use HTTPS without credentials or parameters.');
  }
  const request = options.request ?? fetch;
  return {
    configured: Boolean(endpoint),
    async submit(input: OnboardingEmailSubmission, signal: AbortSignal) {
      if (!endpoint || signal.aborted) return false;
      try {
        const response = await request(endpoint, {
          method: 'POST',
          redirect: 'error',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            version: 1,
            email: input.email,
            consent: true,
            consent_version: 1,
            ...(input.profile ? { profile: onboardingPersonProperties(input.profile) } : {}),
          }),
          signal: AbortSignal.any([signal, AbortSignal.timeout(35_000)]),
        });
        if (response.status !== 200) {
          await response.body?.cancel();
          return false;
        }
        if (!response.body) return false;
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let bytes = 0;
        while (true) {
          const result = await reader.read();
          if (result.done) break;
          bytes += result.value.byteLength;
          if (bytes > 1024) {
            await reader.cancel();
            return false;
          }
          chunks.push(result.value);
        }
        return JSON.parse(Buffer.concat(chunks).toString('utf8'))?.ok === true && !signal.aborted;
      } catch {
        return false;
      }
    },
  };
}
