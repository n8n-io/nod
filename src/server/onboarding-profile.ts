import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { UpdatesSubscription } from '../ports/updates.ts';
import {
  profileCompanySizes,
  profileJobs,
  profileRoles,
  profileScopes,
  profileTextChars,
  type OnboardingProfile,
} from '../shared/onboarding.ts';
import { logFailure } from './failure-log.ts';
import type { MemoryService } from './memory.ts';
import { unsafe } from './memory-tree.ts';

function choice<T extends string>(list: readonly { id: T }[]) {
  return z.enum(list.map((option) => option.id) as [T, ...T[]]);
}

const text = z.string().trim().min(1).max(profileTextChars);
const profileInput = z
  .object({
    scope: choice(profileScopes).optional(),
    role: choice(profileRoles).optional(),
    roleText: text.optional(),
    companySize: choice(profileCompanySizes).optional(),
    jobs: z.array(choice(profileJobs)).max(profileJobs.length),
    jobsText: text.optional(),
  })
  .strict();
const updatesInput = z.object({ email: z.email().max(254) }).strict();

function label(list: readonly { id: string; label: string }[], id?: string) {
  return list.find((option) => option.id === id)?.label;
}

export function profileNote(profile: OnboardingProfile) {
  const own = (value?: string) => (value && !unsafe(value) ? value : undefined);
  const role = own(profile.roleText) ?? label(profileRoles, profile.role);
  const jobs = [
    ...new Set(profile.jobs.map((job) => label(profileJobs, job))),
    own(profile.jobsText),
  ].filter(Boolean);
  return [
    profile.scope && `Where they want Nod’s help: ${label(profileScopes, profile.scope)}.`,
    role && `What they do: ${role}.`,
    profile.companySize && `Company size: ${label(profileCompanySizes, profile.companySize)}.`,
    jobs.length && `What they want off their plate first: ${jobs.join('; ')}.`,
  ]
    .filter(Boolean)
    .join(' ');
}

export function createOnboardingProfile(options: {
  memory: Pick<MemoryService, 'enabled' | 'restate'>;
  updates?: UpdatesSubscription;
}) {
  function registerRoutes(app: FastifyInstance) {
    app.post('/api/onboarding/profile', async (request, response) => {
      const note = profileNote(profileInput.parse(request.body));
      response.header('cache-control', 'no-store');
      if (note && (await options.memory.enabled()))
        await options.memory.restate([{ area: 'about', slug: 'onboarding', text: note }]);
      return { ok: true };
    });
    app.post('/api/onboarding/updates', async (request, response) => {
      const { email } = updatesInput.parse(request.body);
      response.header('cache-control', 'no-store');
      if (!options.updates)
        return response
          .code(404)
          .send({ error: 'Email updates aren’t available in this version of Nod.' });
      try {
        await options.updates(email, AbortSignal.timeout(20_000));
      } catch (error) {
        logFailure('updates_subscription_failed', error);
        return response
          .code(502)
          .send({ error: 'Nod couldn’t sign you up right now. Try again later.' });
      }
      return { ok: true };
    });
  }

  return { available: Boolean(options.updates), registerRoutes };
}
